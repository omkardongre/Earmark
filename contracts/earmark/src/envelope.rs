use near_sdk::json_types::{U64, U128};
use near_sdk::store::{IterableMap, IterableSet};
use near_sdk::{AccountId, near, require};

use crate::{DEFAULT_PENDING_TTL_SECS, EnvelopeId, NANOS_PER_SEC, StorageKey, to_u128};

const MAX_NAME_BYTES: usize = 64;
pub(crate) const MAX_APPROVERS: usize = 10;
pub(crate) const MAX_SPENDERS: usize = 50;
pub(crate) const MAX_PAYEES: usize = 200;
/// Requests waiting for approval at once, so `close_envelope` can reject them all in one call.
pub(crate) const MAX_PENDING: u32 = 50;

#[near(serializers = [json])]
pub struct SpenderInput {
    pub account_id: AccountId,
    /// Requests up to this amount pay at once.
    pub auto_limit: U128,
    /// Most this spender can use per period.
    pub period_cap: U128,
}

/// Rules of a new budget, as passed by the DAO.
#[near(serializers = [json])]
pub struct EnvelopeInput {
    pub name: String,
    pub token_id: AccountId,
    pub spenders: Vec<SpenderInput>,
    pub approvers: Vec<AccountId>,
    /// Requests up to this amount need one approver; above it they go to a DAO vote.
    pub one_approver_limit: U128,
    /// Highest auto limit an approver may raise a spender to.
    pub raise_ceiling: U128,
    pub payees: Vec<AccountId>,
    pub period_secs: U64,
    /// Most the whole budget can pay per period.
    pub period_cap: U128,
    pub pending_ttl_secs: Option<U64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct SpenderLimits {
    pub auto_limit: U128,
    pub period_cap: U128,
    /// Reserved or paid in the period starting at `period_start_ns`.
    pub period_spent: U128,
    pub period_start_ns: U64,
    /// Escalated requests whose DAO proposal is being filed or voted on.
    pub open_escalations: u32,
    pub paused: bool,
}

#[near]
pub struct Envelope {
    pub name: String,
    pub token_id: AccountId,
    pub balance: u128,
    pub committed: u128,
    pub in_flight: u128,
    pub spent_total: u128,
    pub period_secs: u64,
    pub period_cap: u128,
    pub period_spent: u128,
    pub period_start_ns: u64,
    pub spenders: IterableMap<AccountId, SpenderLimits>,
    pub approvers: IterableSet<AccountId>,
    pub one_approver_limit: u128,
    pub raise_ceiling: u128,
    pub payees: IterableSet<AccountId>,
    pub pending_ttl_secs: u64,
    pub paused: bool,
    pub closed: bool,
    /// Requests in `pending_approval`.
    pub pending: IterableSet<String>,
    /// Changes in `queued`.
    pub open_changes: u32,
}

#[near(serializers = [json])]
pub struct EnvelopeView {
    pub id: U64,
    pub name: String,
    pub token_id: AccountId,
    pub balance: U128,
    pub available: U128,
    pub committed: U128,
    pub in_flight: U128,
    pub spent_total: U128,
    pub period_secs: U64,
    pub period_cap: U128,
    pub period_spent: U128,
    pub period_start_ns: U64,
    pub spenders: Vec<(AccountId, SpenderLimits)>,
    pub approvers: Vec<AccountId>,
    pub one_approver_limit: U128,
    pub raise_ceiling: U128,
    pub payees: Vec<AccountId>,
    pub pending_ttl_secs: U64,
    pub paused: bool,
    pub closed: bool,
    pub pending_requests: Vec<String>,
    pub open_changes: u32,
}

impl Envelope {
    /// Validates the DAO's rules and builds an empty, unfunded budget.
    pub fn new(id: EnvelopeId, input: EnvelopeInput, now_ns: u64) -> Self {
        let name = input.name.trim().to_owned();
        require!(
            !name.is_empty() && name.len() <= MAX_NAME_BYTES,
            "invalid_name"
        );
        require!(!input.approvers.is_empty(), "no_approvers");
        require!(input.approvers.len() <= MAX_APPROVERS, "too_many_approvers");
        require!(input.spenders.len() <= MAX_SPENDERS, "too_many_spenders");
        require!(input.payees.len() <= MAX_PAYEES, "too_many_payees");

        let period_secs = input.period_secs.0;
        require!(
            period_secs > 0 && period_secs.checked_mul(NANOS_PER_SEC).is_some(),
            "invalid_period"
        );
        let pending_ttl_secs = input
            .pending_ttl_secs
            .map_or(DEFAULT_PENDING_TTL_SECS, |t| t.0);
        require!(
            pending_ttl_secs > 0 && pending_ttl_secs.checked_mul(NANOS_PER_SEC).is_some(),
            "invalid_ttl"
        );

        let one_approver_limit = to_u128(input.one_approver_limit);
        let raise_ceiling = to_u128(input.raise_ceiling);
        let period_cap = to_u128(input.period_cap);
        // An auto limit above the one-approver limit would skip the approval tier.
        require!(
            raise_ceiling <= one_approver_limit,
            "ceiling_above_one_approver_limit"
        );

        let mut approvers = IterableSet::new(StorageKey::Approvers { envelope_id: id });
        for approver in input.approvers {
            require!(approvers.insert(approver), "duplicate_approver");
        }

        let mut spenders = IterableMap::new(StorageKey::Spenders { envelope_id: id });
        for spender in input.spenders {
            let auto_limit = to_u128(spender.auto_limit);
            require!(auto_limit <= raise_ceiling, "auto_limit_above_ceiling");
            require!(
                to_u128(spender.period_cap) <= period_cap,
                "spender_cap_above_envelope_cap"
            );
            let limits = SpenderLimits {
                auto_limit: spender.auto_limit,
                period_cap: spender.period_cap,
                period_spent: U128(0),
                period_start_ns: U64(now_ns),
                open_escalations: 0,
                paused: false,
            };
            require!(
                spenders.insert(spender.account_id, limits).is_none(),
                "duplicate_spender"
            );
        }

        let mut payees = IterableSet::new(StorageKey::Payees { envelope_id: id });
        for payee in input.payees {
            require!(payees.insert(payee), "duplicate_payee");
        }

        Self {
            name,
            token_id: input.token_id,
            balance: 0,
            committed: 0,
            in_flight: 0,
            spent_total: 0,
            period_secs,
            period_cap,
            period_spent: 0,
            period_start_ns: now_ns,
            spenders,
            approvers,
            one_approver_limit,
            raise_ceiling,
            payees,
            pending_ttl_secs,
            paused: false,
            closed: false,
            pending: IterableSet::new(StorageKey::Pending { envelope_id: id }),
            open_changes: 0,
        }
    }

    /// Moves the period window forward if `now_ns` is past it, resetting the period total.
    pub fn roll_period(&mut self, now_ns: u64) {
        let period_ns = self.period_secs * NANOS_PER_SEC;
        let elapsed = now_ns.saturating_sub(self.period_start_ns);
        if elapsed >= period_ns {
            self.period_start_ns += elapsed / period_ns * period_ns;
            self.period_spent = 0;
        }
    }

    /// Spender limits for the current period window (call after `roll_period`).
    pub fn spender_current(&self, spender: &AccountId) -> Option<SpenderLimits> {
        let mut limits = self.spenders.get(spender)?.clone();
        if limits.period_start_ns.0 != self.period_start_ns {
            limits.period_start_ns = U64(self.period_start_ns);
            limits.period_spent = U128(0);
        }
        Some(limits)
    }

    /// `balance - committed - in_flight`; never negative by construction (R4).
    pub fn available(&self) -> u128 {
        self.balance - self.committed - self.in_flight
    }

    pub fn view(&self, id: EnvelopeId) -> EnvelopeView {
        EnvelopeView {
            id: U64(id),
            name: self.name.clone(),
            token_id: self.token_id.clone(),
            balance: U128(self.balance),
            available: U128(self.available()),
            committed: U128(self.committed),
            in_flight: U128(self.in_flight),
            spent_total: U128(self.spent_total),
            period_secs: U64(self.period_secs),
            period_cap: U128(self.period_cap),
            period_spent: U128(self.period_spent),
            period_start_ns: U64(self.period_start_ns),
            spenders: self
                .spenders
                .iter()
                .map(|(a, l)| (a.clone(), l.clone()))
                .collect(),
            approvers: self.approvers.iter().cloned().collect(),
            one_approver_limit: U128(self.one_approver_limit),
            raise_ceiling: U128(self.raise_ceiling),
            payees: self.payees.iter().cloned().collect(),
            pending_ttl_secs: U64(self.pending_ttl_secs),
            paused: self.paused,
            closed: self.closed,
            pending_requests: self.pending.iter().cloned().collect(),
            open_changes: self.open_changes,
        }
    }
}
