//! Earmark: DAO-funded budgets with spending limits, approval tiers and escalation to DAO votes.

mod approval;
mod changes;
mod close;
mod envelope;
mod events;
mod funding;
mod request;
mod spend;

use near_sdk::json_types::{U64, U128};
use near_sdk::store::{IterableMap, IterableSet, LookupMap};
use near_sdk::{
    AccountId, BorshStorageKey, CryptoHash, Gas, NearToken, PanicOnDefault, Promise, env, near,
    require,
};

pub use changes::{Change, ChangeStatus, EligibilityRules, QueuedChange};
pub use envelope::{Envelope, EnvelopeInput, EnvelopeView, SpenderInput, SpenderLimits};
use events::Event;
pub use request::{BlockReason, Record, Request, RequestStatus, SpendCheck, Tier};

pub type EnvelopeId = u64;

/// Default time a loosening change waits before it can be applied (24 h).
pub const DEFAULT_LOOSEN_DELAY_SECS: u64 = 86_400;
/// Default time a pending request waits for approval before it expires (72 h).
pub const DEFAULT_PENDING_TTL_SECS: u64 = 259_200;

pub(crate) const NANOS_PER_SEC: u64 = 1_000_000_000;
const MAX_TOKENS: usize = 10;
pub(crate) const MAX_LIST_LIMIT: u32 = 100;
const GAS_MIGRATE: Gas = Gas::from_tgas(30);

#[near]
#[derive(BorshStorageKey)]
pub(crate) enum StorageKey {
    Tokens,
    Envelopes,
    Approvers { envelope_id: EnvelopeId },
    Spenders { envelope_id: EnvelopeId },
    Payees { envelope_id: EnvelopeId },
    Pending { envelope_id: EnvelopeId },
    Requests,
    WorkClaims,
    WorkOverrides,
    Records,
    Changes,
    QueuedIds,
    PendingPayees,
    EnvelopeRequests { envelope_id: EnvelopeId },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    dao_id: AccountId,
    token_ids: IterableSet<AccountId>,
    envelopes: IterableMap<EnvelopeId, Envelope>,
    next_envelope_id: EnvelopeId,
    loosen_delay_secs: u64,
    requests: LookupMap<String, Request>,
    /// R16: `(envelope, payee, work_ref)` -> request id; set at request, kept when paid,
    /// freed when the request fails, is rejected or expires.
    work_claims: LookupMap<CryptoHash, String>,
    /// One-time passes for a repeat `work_ref`, set by an approver with a reason (R16).
    work_overrides: LookupMap<CryptoHash, ()>,
    records: LookupMap<AccountId, Record>,
    eligibility: EligibilityRules,
    changes: LookupMap<u64, QueuedChange>,
    /// Ids of changes still `queued`.
    queued_ids: IterableSet<u64>,
    next_change_id: u64,
    /// `(envelope, payee)` -> queued `AddPayee` change, so the payee shows as `payee_pending`.
    pending_payees: LookupMap<CryptoHash, u64>,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub dao_id: AccountId,
    pub token_ids: Vec<AccountId>,
    pub loosen_delay_secs: U64,
    pub eligibility: EligibilityRules,
    pub envelope_count: U64,
}

#[near]
impl Contract {
    /// Called once in the deploy transaction, by the contract account itself.
    #[init]
    #[private]
    pub fn new(
        dao_id: AccountId,
        token_ids: Vec<AccountId>,
        loosen_delay_secs: Option<U64>,
        eligibility: Option<EligibilityRules>,
    ) -> Self {
        require!(!token_ids.is_empty(), "no_tokens");
        require!(token_ids.len() <= MAX_TOKENS, "too_many_tokens");
        let mut tokens = IterableSet::new(StorageKey::Tokens);
        for token_id in token_ids {
            require!(tokens.insert(token_id), "duplicate_token");
        }
        Self {
            dao_id,
            token_ids: tokens,
            envelopes: IterableMap::new(StorageKey::Envelopes),
            next_envelope_id: 0,
            loosen_delay_secs: loosen_delay_secs.map_or(DEFAULT_LOOSEN_DELAY_SECS, |d| d.0),
            requests: LookupMap::new(StorageKey::Requests),
            work_claims: LookupMap::new(StorageKey::WorkClaims),
            work_overrides: LookupMap::new(StorageKey::WorkOverrides),
            records: LookupMap::new(StorageKey::Records),
            eligibility: eligibility.unwrap_or_default(),
            changes: LookupMap::new(StorageKey::Changes),
            queued_ids: IterableSet::new(StorageKey::QueuedIds),
            next_change_id: 0,
            pending_payees: LookupMap::new(StorageKey::PendingPayees),
        }
    }

    /// Creates a budget. DAO only, through a `FunctionCall` proposal. The attached deposit must
    /// cover the storage it uses; the rest is refunded to the DAO.
    #[payable]
    pub fn create_envelope(&mut self, envelope: EnvelopeInput) -> U64 {
        self.assert_dao();
        require!(
            self.token_ids.contains(&envelope.token_id),
            "token_not_allowed"
        );

        let storage_before = env::storage_usage();
        let envelope_id = self.next_envelope_id;
        self.next_envelope_id += 1;
        let created = Envelope::new(envelope_id, envelope, env::block_timestamp());
        let name = created.name.clone();
        let token_id = created.token_id.clone();
        self.envelopes.insert(envelope_id, created);
        self.envelopes.flush();
        let storage_used = env::storage_usage().saturating_sub(storage_before);

        Event::EnvelopeCreated {
            envelope_id: U64(envelope_id),
            name: &name,
            token_id: &token_id,
        }
        .emit();
        charge_storage(storage_used, &self.dao_id);
        U64(envelope_id)
    }

    /// Replaces the contract code. DAO only, through a Sputnik `UpgradeRemote` proposal: the DAO
    /// passes a stored blob (the new wasm) as raw input. The contract account has no full-access
    /// key, so this is the only way to change the code (R12).
    pub fn upgrade(&self) -> Promise {
        self.assert_dao();
        let code = env::input().unwrap_or_else(|| env::panic_str("no_code"));
        require!(!code.is_empty(), "no_code");
        Promise::new(env::current_account_id())
            .deploy_contract(code)
            .function_call(
                "migrate".to_owned(),
                vec![],
                NearToken::from_yoctonear(0),
                GAS_MIGRATE,
            )
            .as_return()
    }

    /// Runs after `upgrade`. Reads the stored state as is; a release that changes the layout
    /// converts it here.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        env::state_read().unwrap_or_else(|| env::panic_str("no_state"))
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            dao_id: self.dao_id.clone(),
            token_ids: self.token_ids.iter().cloned().collect(),
            loosen_delay_secs: U64(self.loosen_delay_secs),
            eligibility: self.eligibility.clone(),
            envelope_count: U64(self.next_envelope_id),
        }
    }

    pub fn get_envelope(&self, envelope_id: U64) -> Option<EnvelopeView> {
        self.envelopes
            .get(&envelope_id.0)
            .map(|e| e.view(envelope_id.0))
    }

    pub fn list_envelopes(&self, from_index: Option<U64>, limit: Option<u32>) -> Vec<EnvelopeView> {
        let limit = limit.unwrap_or(MAX_LIST_LIMIT).min(MAX_LIST_LIMIT) as usize;
        self.envelopes
            .iter()
            .skip(from_index.map_or(0, |i| i.0) as usize)
            .take(limit)
            .map(|(id, e)| e.view(*id))
            .collect()
    }
}

impl Contract {
    pub(crate) fn assert_dao(&self) {
        require!(env::predecessor_account_id() == self.dao_id, "not_dao");
    }
}

/// Requires the attached deposit to cover `bytes` of storage and refunds the excess.
fn charge_storage(bytes: u64, refund_to: &AccountId) {
    let cost = env::storage_byte_cost().saturating_mul(u128::from(bytes));
    let attached = env::attached_deposit();
    require!(
        attached >= cost,
        format!("insufficient_storage_deposit: need {cost}")
    );
    let refund = attached.saturating_sub(cost);
    if refund > NearToken::from_yoctonear(0) {
        Promise::new(refund_to.clone()).transfer(refund).detach();
    }
}

/// Amounts are token base units (R15).
pub(crate) fn to_u128(amount: U128) -> u128 {
    amount.0
}

#[cfg(test)]
mod tests;
