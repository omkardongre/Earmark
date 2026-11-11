//! Earmark: DAO-funded budgets with spending limits, approval tiers and escalation to DAO votes.

mod approval;
mod changes;
mod close;
mod envelope;
mod events;
mod funding;
mod intents;
mod request;
mod spend;
mod tasks;

use near_sdk::json_types::{U64, U128};
use near_sdk::store::{IterableMap, IterableSet, LookupMap, LookupSet};
use near_sdk::{
    AccountId, BorshStorageKey, CryptoHash, Gas, NearToken, PanicOnDefault, Promise, env, near,
    require,
};

pub use changes::{Change, ChangeStatus, EligibilityRules, QueuedChange};
pub use envelope::{Envelope, EnvelopeInput, EnvelopeView, SpenderInput, SpenderLimits};
use events::Event;
use near_sdk::borsh;
use request::RequestCount;
pub use request::{BlockReason, PayeeRecord, Record, Request, RequestStatus, SpendCheck, Tier};
use tasks::TaskList;
pub use tasks::{PayeeTrust, Task, TaskRules, TaskStatus, TrustView};

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
    PayeeRecords,
    RequestCounts,
    // Tasks (added after R23). New variants go at the end only: each prefix is its index.
    Tasks,
    TaskLists,
    EnvelopeTasks { envelope_id: EnvelopeId },
    TaskRules,
    Trust,
    TaskRequests,
    // near.com payouts (Feature 3).
    IntentsPayees,
    IntentsRequests,
}

/// The NEAR Intents contract that holds near.com balances on mainnet.
const MAINNET_INTENTS: &str = "intents.near";

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
    /// R21: what each payee has been paid, across budgets.
    payee_records: LookupMap<AccountId, PayeeRecord>,
    /// R19: requests per `(envelope, spender)` in the current period.
    request_counts: LookupMap<CryptoHash, RequestCount>,
    tasks: LookupMap<u64, Task>,
    next_task_id: u64,
    /// Per budget: task ids and the reserved ones.
    task_lists: LookupMap<EnvelopeId, TaskList>,
    /// Per budget trust rules, set by the DAO.
    task_rules: LookupMap<EnvelopeId, TaskRules>,
    /// `(envelope, payee)` -> accepted, paid tasks and strikes.
    trust: LookupMap<CryptoHash, PayeeTrust>,
    /// Payment request id -> the task it pays.
    task_requests: LookupMap<String, u64>,
    /// Where near.com payees are paid (`intents.near` on mainnet). `None`: near.com payees
    /// can't be added. Fixed at deploy or upgrade.
    intents_contract: Option<AccountId>,
    /// `(envelope, payee)` keys of payees paid into their near.com balance.
    intents_payees: LookupSet<CryptoHash>,
    /// Requests whose payee was a near.com payee when the request was made. Paid that way even
    /// if the payee is removed or re-added later.
    intents_requests: LookupSet<String>,
}

/// State layout with tasks, before near.com payouts (testnet since 11 Nov). `migrate` converts
/// it.
#[near]
struct ContractV3 {
    dao_id: AccountId,
    token_ids: IterableSet<AccountId>,
    envelopes: IterableMap<EnvelopeId, Envelope>,
    next_envelope_id: EnvelopeId,
    loosen_delay_secs: u64,
    requests: LookupMap<String, Request>,
    work_claims: LookupMap<CryptoHash, String>,
    work_overrides: LookupMap<CryptoHash, ()>,
    records: LookupMap<AccountId, Record>,
    eligibility: EligibilityRules,
    changes: LookupMap<u64, QueuedChange>,
    queued_ids: IterableSet<u64>,
    next_change_id: u64,
    pending_payees: LookupMap<CryptoHash, u64>,
    payee_records: LookupMap<AccountId, PayeeRecord>,
    request_counts: LookupMap<CryptoHash, RequestCount>,
    tasks: LookupMap<u64, Task>,
    next_task_id: u64,
    task_lists: LookupMap<EnvelopeId, TaskList>,
    task_rules: LookupMap<EnvelopeId, TaskRules>,
    trust: LookupMap<CryptoHash, PayeeTrust>,
    task_requests: LookupMap<String, u64>,
}

impl From<ContractV3> for Contract {
    fn from(old: ContractV3) -> Self {
        Self {
            dao_id: old.dao_id,
            token_ids: old.token_ids,
            envelopes: old.envelopes,
            next_envelope_id: old.next_envelope_id,
            loosen_delay_secs: old.loosen_delay_secs,
            requests: old.requests,
            work_claims: old.work_claims,
            work_overrides: old.work_overrides,
            records: old.records,
            eligibility: old.eligibility,
            changes: old.changes,
            queued_ids: old.queued_ids,
            next_change_id: old.next_change_id,
            pending_payees: old.pending_payees,
            payee_records: old.payee_records,
            request_counts: old.request_counts,
            tasks: old.tasks,
            next_task_id: old.next_task_id,
            task_lists: old.task_lists,
            task_rules: old.task_rules,
            trust: old.trust,
            task_requests: old.task_requests,
            intents_contract: default_intents(),
            intents_payees: LookupSet::new(StorageKey::IntentsPayees),
            intents_requests: LookupSet::new(StorageKey::IntentsRequests),
        }
    }
}

/// State layout from R18 to R23 (mainnet `budgets.omkar5.near` and testnet since 7 Nov).
/// `migrate` converts it.
#[near]
struct ContractV2 {
    dao_id: AccountId,
    token_ids: IterableSet<AccountId>,
    envelopes: IterableMap<EnvelopeId, Envelope>,
    next_envelope_id: EnvelopeId,
    loosen_delay_secs: u64,
    requests: LookupMap<String, Request>,
    work_claims: LookupMap<CryptoHash, String>,
    work_overrides: LookupMap<CryptoHash, ()>,
    records: LookupMap<AccountId, Record>,
    eligibility: EligibilityRules,
    changes: LookupMap<u64, QueuedChange>,
    queued_ids: IterableSet<u64>,
    next_change_id: u64,
    pending_payees: LookupMap<CryptoHash, u64>,
    payee_records: LookupMap<AccountId, PayeeRecord>,
    request_counts: LookupMap<CryptoHash, RequestCount>,
}

impl From<ContractV2> for ContractV3 {
    fn from(old: ContractV2) -> Self {
        Self {
            dao_id: old.dao_id,
            token_ids: old.token_ids,
            envelopes: old.envelopes,
            next_envelope_id: old.next_envelope_id,
            loosen_delay_secs: old.loosen_delay_secs,
            requests: old.requests,
            work_claims: old.work_claims,
            work_overrides: old.work_overrides,
            records: old.records,
            eligibility: old.eligibility,
            changes: old.changes,
            queued_ids: old.queued_ids,
            next_change_id: old.next_change_id,
            pending_payees: old.pending_payees,
            payee_records: old.payee_records,
            request_counts: old.request_counts,
            tasks: LookupMap::new(StorageKey::Tasks),
            next_task_id: 0,
            task_lists: LookupMap::new(StorageKey::TaskLists),
            task_rules: LookupMap::new(StorageKey::TaskRules),
            trust: LookupMap::new(StorageKey::Trust),
            task_requests: LookupMap::new(StorageKey::TaskRequests),
        }
    }
}

/// State layout before R18–R21 (deployed as `v4.earmark.testnet`). `migrate` converts it.
#[near]
struct ContractV1 {
    dao_id: AccountId,
    token_ids: IterableSet<AccountId>,
    envelopes: IterableMap<EnvelopeId, Envelope>,
    next_envelope_id: EnvelopeId,
    loosen_delay_secs: u64,
    requests: LookupMap<String, Request>,
    work_claims: LookupMap<CryptoHash, String>,
    work_overrides: LookupMap<CryptoHash, ()>,
    records: LookupMap<AccountId, Record>,
    eligibility: EligibilityRules,
    changes: LookupMap<u64, QueuedChange>,
    queued_ids: IterableSet<u64>,
    next_change_id: u64,
    pending_payees: LookupMap<CryptoHash, u64>,
}

impl From<ContractV1> for ContractV2 {
    fn from(old: ContractV1) -> Self {
        Self {
            dao_id: old.dao_id,
            token_ids: old.token_ids,
            envelopes: old.envelopes,
            next_envelope_id: old.next_envelope_id,
            loosen_delay_secs: old.loosen_delay_secs,
            requests: old.requests,
            work_claims: old.work_claims,
            work_overrides: old.work_overrides,
            records: old.records,
            eligibility: old.eligibility,
            changes: old.changes,
            queued_ids: old.queued_ids,
            next_change_id: old.next_change_id,
            pending_payees: old.pending_payees,
            payee_records: LookupMap::new(StorageKey::PayeeRecords),
            request_counts: LookupMap::new(StorageKey::RequestCounts),
        }
    }
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub dao_id: AccountId,
    pub token_ids: Vec<AccountId>,
    pub loosen_delay_secs: U64,
    pub eligibility: EligibilityRules,
    pub envelope_count: U64,
    /// Where near.com payees are paid; `None` when this contract can't pay them.
    pub intents_contract: Option<AccountId>,
}

#[near]
impl Contract {
    /// Called once in the deploy transaction, by the contract account itself. `intents_contract`
    /// defaults to `intents.near` for a `.near` account and to none elsewhere (NEAR Intents has
    /// no testnet), so a test deploy can name its own copy.
    #[init]
    #[private]
    pub fn new(
        dao_id: AccountId,
        token_ids: Vec<AccountId>,
        loosen_delay_secs: Option<U64>,
        eligibility: Option<EligibilityRules>,
        intents_contract: Option<AccountId>,
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
            payee_records: LookupMap::new(StorageKey::PayeeRecords),
            request_counts: LookupMap::new(StorageKey::RequestCounts),
            tasks: LookupMap::new(StorageKey::Tasks),
            next_task_id: 0,
            task_lists: LookupMap::new(StorageKey::TaskLists),
            task_rules: LookupMap::new(StorageKey::TaskRules),
            trust: LookupMap::new(StorageKey::Trust),
            task_requests: LookupMap::new(StorageKey::TaskRequests),
            intents_contract: intents_contract.or_else(default_intents),
            intents_payees: LookupSet::new(StorageKey::IntentsPayees),
            intents_requests: LookupSet::new(StorageKey::IntentsRequests),
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

    /// Runs after `upgrade`. Reads the current layout as is, or converts an older one: before
    /// near.com payouts (tasks), before tasks (R18–R23), or before R18–R21. Requests, records
    /// and claims keep their storage; only the root changes.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let raw = env::storage_read(b"STATE").unwrap_or_else(|| env::panic_str("no_state"));
        if let Ok(current) = borsh::from_slice::<Self>(&raw) {
            return current;
        }
        if let Ok(v3) = borsh::from_slice::<ContractV3>(&raw) {
            return v3.into();
        }
        if let Ok(v2) = borsh::from_slice::<ContractV2>(&raw) {
            return ContractV3::from(v2).into();
        }
        borsh::from_slice::<ContractV1>(&raw)
            .map(|v1| ContractV3::from(ContractV2::from(v1)).into())
            .unwrap_or_else(|_| env::panic_str("unknown_state_layout"))
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            dao_id: self.dao_id.clone(),
            token_ids: self.token_ids.iter().cloned().collect(),
            loosen_delay_secs: U64(self.loosen_delay_secs),
            eligibility: self.eligibility.clone(),
            envelope_count: U64(self.next_envelope_id),
            intents_contract: self.intents_contract.clone(),
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

/// `intents.near` for a mainnet (`.near`) contract; none elsewhere.
fn default_intents() -> Option<AccountId> {
    env::current_account_id()
        .as_str()
        .ends_with(".near")
        .then(|| MAINNET_INTENTS.parse().unwrap())
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
