//! Rule changes (R10, R11, R13, R14). Tightening applies at once. Loosening is queued: anyone can
//! apply it after the delay, and any approver or the DAO can cancel it before then.

use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, CryptoHash, env, near, require};

use crate::events::Event;
use crate::{Contract, ContractExt, Envelope, EnvelopeId, NANOS_PER_SEC, SpenderLimits};

/// A queued change that nobody applied within this window after `effective_at` can't be
/// applied any more (so an old approval can't be used much later).
pub const CHANGE_GRACE_SECS: u64 = 1_209_600;
/// Queued changes open at once per budget.
pub const MAX_OPEN_CHANGES: u32 = 20;
const MAX_CHANGES_PER_CALL: usize = 20;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Change {
    SpenderAutoLimit {
        spender: AccountId,
        amount: U128,
    },
    SpenderPeriodCap {
        spender: AccountId,
        amount: U128,
    },
    PeriodCap {
        amount: U128,
    },
    OneApproverLimit {
        amount: U128,
    },
    RaiseCeiling {
        amount: U128,
    },
    AddSpender {
        spender: AccountId,
        auto_limit: U128,
        period_cap: U128,
    },
    RemoveSpender {
        spender: AccountId,
    },
    AddApprover {
        approver: AccountId,
    },
    RemoveApprover {
        approver: AccountId,
    },
    AddPayee {
        payee: AccountId,
    },
    RemovePayee {
        payee: AccountId,
    },
    /// The whole budget when `spender` is `None`.
    Pause {
        spender: Option<AccountId>,
    },
    Unpause {
        spender: Option<AccountId>,
    },
}

impl Change {
    /// R11: approvers manage payees, a spender's auto limit and pausing. The rest is DAO only.
    fn approver_may(&self) -> bool {
        matches!(
            self,
            Self::AddPayee { .. }
                | Self::RemovePayee { .. }
                | Self::SpenderAutoLimit { .. }
                | Self::Pause { .. }
                | Self::Unpause { .. }
        )
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChangeStatus {
    Queued,
    Applied,
    Cancelled,
    /// Not applied within the grace window.
    Stale,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct QueuedChange {
    pub envelope_id: U64,
    pub change: Change,
    pub queued_by: AccountId,
    pub by_dao: bool,
    pub queued_at_ns: U64,
    pub effective_at_ns: U64,
    pub status: ChangeStatus,
}

/// R9: when a spender's auto limit may be raised by an approver.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct EligibilityRules {
    pub min_paid_count: u32,
    /// Time from the first paid request.
    pub min_history_secs: U64,
    /// No for-cause rejection within this time.
    pub cause_cooldown_secs: U64,
}

impl Default for EligibilityRules {
    fn default() -> Self {
        Self {
            min_paid_count: 10,
            min_history_secs: U64(14 * 86_400),
            cause_cooldown_secs: U64(30 * 86_400),
        }
    }
}

#[near]
impl Contract {
    /// DAO only, through a `FunctionCall` proposal. Each change that tightens applies now; each
    /// that loosens is queued. Returns the queued change id per change, or `None` if applied.
    pub fn update_envelope(&mut self, envelope_id: U64, changes: Vec<Change>) -> Vec<Option<U64>> {
        self.assert_dao();
        require!(
            !changes.is_empty() && changes.len() <= MAX_CHANGES_PER_CALL,
            "invalid_changes"
        );
        changes
            .into_iter()
            .map(|change| self.submit(envelope_id.0, change, None))
            .collect()
    }

    /// Approver or DAO. Queued; the payee can be paid once the change is applied.
    pub fn approve_payee(&mut self, envelope_id: U64, payee: AccountId) -> U64 {
        let id = self.submit(envelope_id.0, Change::AddPayee { payee }, Some(true));
        id.unwrap()
    }

    /// Approver or DAO. Instant; also cancels a queued add of the same payee.
    pub fn remove_payee(&mut self, envelope_id: U64, payee: AccountId) {
        self.submit(envelope_id.0, Change::RemovePayee { payee }, Some(false));
    }

    /// Approver (not the spender) or DAO. Queued; needs `new_limit <= raise_ceiling` and, from an
    /// approver, an eligible spender (R9, R10). Both are checked again when applied.
    pub fn raise_limit(&mut self, envelope_id: U64, spender: AccountId, new_limit: U128) -> U64 {
        let change = Change::SpenderAutoLimit {
            spender,
            amount: new_limit,
        };
        self.submit(envelope_id.0, change, Some(true)).unwrap()
    }

    /// Approver or DAO. Instant.
    pub fn lower_limit(&mut self, envelope_id: U64, spender: AccountId, new_limit: U128) {
        let change = Change::SpenderAutoLimit {
            spender,
            amount: new_limit,
        };
        self.submit(envelope_id.0, change, Some(false));
    }

    /// Any approver or the DAO. Instant: blocks new requests and pending approvals.
    pub fn pause(&mut self, envelope_id: U64, spender: Option<AccountId>) {
        self.submit(envelope_id.0, Change::Pause { spender }, Some(false));
    }

    /// Approver or DAO. Queued.
    pub fn unpause(&mut self, envelope_id: U64, spender: Option<AccountId>) -> U64 {
        self.submit(envelope_id.0, Change::Unpause { spender }, Some(true))
            .unwrap()
    }

    /// Anyone, after `effective_at` and within the grace window. Checks the change again against
    /// the current rules (ceiling, eligibility), so a change the DAO has since tightened fails.
    pub fn apply_change(&mut self, change_id: U64) -> ChangeStatus {
        let mut queued = self.queued(change_id.0);
        let now = env::block_timestamp();
        require!(now >= queued.effective_at_ns.0, "not_yet");
        let grace_ns = CHANGE_GRACE_SECS * NANOS_PER_SEC;
        if now > queued.effective_at_ns.0.saturating_add(grace_ns) {
            self.finish(change_id.0, &mut queued, ChangeStatus::Stale);
            Event::ChangeStale { change_id }.emit();
            return ChangeStatus::Stale;
        }

        let id = queued.envelope_id.0;
        let envelope = self.envelopes.get(&id).unwrap();
        require!(!envelope.closed, "closed");
        let loosening = envelope
            .validate(&queued.change)
            .unwrap_or_else(|e| env::panic_str(e));
        if loosening && !queued.by_dao {
            require!(
                envelope.approvers.contains(&queued.queued_by),
                "not_approver"
            );
            self.check_raise(&queued.change, &queued.queued_by);
        }
        let now = env::block_timestamp();
        self.envelopes
            .get_mut(&id)
            .unwrap()
            .apply(&queued.change, now);
        Event::ChangeApplied {
            change_id: Some(change_id),
            envelope_id: queued.envelope_id,
            change: &queued.change,
        }
        .emit();
        self.finish(change_id.0, &mut queued, ChangeStatus::Applied);
        ChangeStatus::Applied
    }

    /// Any approver of the budget or the DAO, while the change is queued.
    pub fn cancel_change(&mut self, change_id: U64) {
        let mut queued = self.queued(change_id.0);
        let caller = env::predecessor_account_id();
        let envelope = self.envelopes.get(&queued.envelope_id.0).unwrap();
        require!(
            caller == self.dao_id || envelope.approvers.contains(&caller),
            "not_approver"
        );
        self.finish(change_id.0, &mut queued, ChangeStatus::Cancelled);
        Event::ChangeCancelled {
            change_id,
            by: &caller,
        }
        .emit();
    }

    pub fn get_change(&self, change_id: U64) -> Option<QueuedChange> {
        self.changes.get(&change_id.0).cloned()
    }

    /// Changes still waiting, oldest first.
    pub fn list_queued(&self, envelope_id: Option<U64>) -> Vec<(U64, QueuedChange)> {
        self.queued_ids
            .iter()
            .filter_map(|id| Some((U64(*id), self.changes.get(id)?.clone())))
            .filter(|(_, c)| envelope_id.is_none_or(|e| e == c.envelope_id))
            .collect()
    }

    /// R9: whether an approver may raise this spender's auto limit.
    pub fn eligible(&self, account_id: AccountId) -> bool {
        let Some(record) = self.records.get(&account_id) else {
            return false;
        };
        let now = env::block_timestamp();
        let rules = &self.eligibility;
        let after = |start: U64, secs: U64| {
            now >= start.0.saturating_add(secs.0.saturating_mul(NANOS_PER_SEC))
        };
        record.paid_count >= rules.min_paid_count
            && record
                .first_paid_at_ns
                .is_some_and(|t| after(t, rules.min_history_secs))
            && record
                .last_reject_at_ns
                .is_none_or(|t| after(t, rules.cause_cooldown_secs))
    }
}

impl Contract {
    /// Validates `change`, then applies it now if it tightens or queues it if it loosens.
    /// `expect_loosening` lets the named methods refuse the other direction.
    fn submit(
        &mut self,
        envelope_id: EnvelopeId,
        change: Change,
        expect_loosening: Option<bool>,
    ) -> Option<U64> {
        let caller = env::predecessor_account_id();
        let by_dao = caller == self.dao_id;
        let envelope = self
            .envelopes
            .get(&envelope_id)
            .unwrap_or_else(|| env::panic_str("unknown_envelope"));
        require!(!envelope.closed, "closed");
        if !by_dao {
            require!(envelope.approvers.contains(&caller), "not_approver");
            require!(change.approver_may(), "dao_only");
        }

        // A removed payee must not come back through a change queued earlier.
        if let Change::RemovePayee { payee } = &change {
            let key = payee_key(envelope_id, payee);
            let pending = self.pending_payees.get(&key).copied();
            if let Some(pending) = pending {
                let mut queued = self.queued(pending);
                self.finish(pending, &mut queued, ChangeStatus::Cancelled);
                Event::ChangeCancelled {
                    change_id: U64(pending),
                    by: &caller,
                }
                .emit();
            }
            let allowed = self
                .envelopes
                .get(&envelope_id)
                .unwrap()
                .payees
                .contains(payee);
            if pending.is_some() && !allowed {
                return None;
            }
        }

        let envelope = self.envelopes.get(&envelope_id).unwrap();
        let loosening = envelope
            .validate(&change)
            .unwrap_or_else(|e| env::panic_str(e));
        if let Some(expected) = expect_loosening {
            require!(
                loosening == expected,
                if expected {
                    "not_a_raise"
                } else {
                    "not_a_lowering"
                }
            );
        }
        let now = env::block_timestamp();
        if !loosening {
            self.envelopes
                .get_mut(&envelope_id)
                .unwrap()
                .apply(&change, now);
            Event::ChangeApplied {
                change_id: None,
                envelope_id: U64(envelope_id),
                change: &change,
            }
            .emit();
            return None;
        }

        if !by_dao {
            self.check_raise(&change, &caller);
        }
        let envelope = self.envelopes.get_mut(&envelope_id).unwrap();
        require!(envelope.open_changes < MAX_OPEN_CHANGES, "too_many_queued");
        envelope.open_changes += 1;
        if let Change::AddPayee { payee } = &change {
            let key = payee_key(envelope_id, payee);
            require!(!self.pending_payees.contains_key(&key), "already_queued");
            self.pending_payees.insert(key, self.next_change_id);
        }

        let change_id = self.next_change_id;
        self.next_change_id += 1;
        let effective_at_ns =
            now.saturating_add(self.loosen_delay_secs.saturating_mul(NANOS_PER_SEC));
        Event::ChangeQueued {
            change_id: U64(change_id),
            envelope_id: U64(envelope_id),
            change: &change,
            queued_by: &caller,
            effective_at_ns: U64(effective_at_ns),
        }
        .emit();
        self.changes.insert(
            change_id,
            QueuedChange {
                envelope_id: U64(envelope_id),
                change,
                queued_by: caller,
                by_dao,
                queued_at_ns: U64(now),
                effective_at_ns: U64(effective_at_ns),
                status: ChangeStatus::Queued,
            },
        );
        self.queued_ids.insert(change_id);
        Some(U64(change_id))
    }

    /// An approver's raise of an auto limit: not their own, and only for an eligible spender.
    fn check_raise(&self, change: &Change, approver: &AccountId) {
        if let Change::SpenderAutoLimit { spender, .. } = change {
            require!(spender != approver, "self_raise");
            require!(self.eligible(spender.clone()), "not_eligible");
        }
    }

    pub(crate) fn queued(&self, change_id: u64) -> QueuedChange {
        let queued = self
            .changes
            .get(&change_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown_change"));
        require!(queued.status == ChangeStatus::Queued, "not_queued");
        queued
    }

    pub(crate) fn finish(
        &mut self,
        change_id: u64,
        queued: &mut QueuedChange,
        status: ChangeStatus,
    ) {
        let id = queued.envelope_id.0;
        let envelope = self.envelopes.get_mut(&id).unwrap();
        envelope.open_changes = envelope.open_changes.saturating_sub(1);
        if let Change::AddPayee { payee } = &queued.change {
            self.pending_payees.remove(&payee_key(id, payee));
        }
        queued.status = status;
        self.changes.insert(change_id, queued.clone());
        self.queued_ids.remove(&change_id);
    }

    pub(crate) fn payee_pending(&self, envelope_id: EnvelopeId, payee: &AccountId) -> bool {
        self.pending_payees
            .contains_key(&payee_key(envelope_id, payee))
    }
}

fn payee_key(envelope_id: EnvelopeId, payee: &AccountId) -> CryptoHash {
    let mut data = envelope_id.to_le_bytes().to_vec();
    data.extend_from_slice(payee.as_bytes());
    env::sha256_array(&data)
}

impl Envelope {
    /// Checks `change` against the current rules. `Ok(true)` if it loosens (R13), `Ok(false)`
    /// if it tightens (R14).
    pub fn validate(&self, change: &Change) -> Result<bool, &'static str> {
        let differs = |old: u128, new: u128| {
            if old == new {
                Err("no_change")
            } else {
                Ok(new > old)
            }
        };
        let limits = |spender: &AccountId| self.spenders.get(spender).ok_or("not_spender");
        match change {
            Change::SpenderAutoLimit { spender, amount } => {
                let up = differs(limits(spender)?.auto_limit.0, amount.0)?;
                if up && amount.0 > self.raise_ceiling {
                    return Err("above_ceiling");
                }
                Ok(up)
            }
            Change::SpenderPeriodCap { spender, amount } => {
                let up = differs(limits(spender)?.period_cap.0, amount.0)?;
                if up && amount.0 > self.period_cap {
                    return Err("spender_cap_above_envelope_cap");
                }
                Ok(up)
            }
            Change::PeriodCap { amount } => differs(self.period_cap, amount.0),
            Change::OneApproverLimit { amount } => differs(self.one_approver_limit, amount.0),
            Change::RaiseCeiling { amount } => {
                let up = differs(self.raise_ceiling, amount.0)?;
                if up && amount.0 > self.one_approver_limit {
                    return Err("ceiling_above_one_approver_limit");
                }
                Ok(up)
            }
            Change::AddSpender {
                spender,
                auto_limit,
                period_cap,
            } => {
                if self.spenders.contains_key(spender) {
                    return Err("duplicate_spender");
                }
                if self.spenders.len() as usize >= crate::envelope::MAX_SPENDERS {
                    return Err("too_many_spenders");
                }
                if auto_limit.0 > self.raise_ceiling {
                    return Err("auto_limit_above_ceiling");
                }
                if period_cap.0 > self.period_cap {
                    return Err("spender_cap_above_envelope_cap");
                }
                Ok(true)
            }
            Change::RemoveSpender { spender } => limits(spender).map(|_| false),
            Change::AddApprover { approver } => {
                if self.approvers.contains(approver) {
                    return Err("duplicate_approver");
                }
                if self.approvers.len() as usize >= crate::envelope::MAX_APPROVERS {
                    return Err("too_many_approvers");
                }
                Ok(true)
            }
            Change::RemoveApprover { approver } => {
                if !self.approvers.contains(approver) {
                    return Err("not_approver");
                }
                if self.approvers.len() <= 1 {
                    return Err("no_approvers");
                }
                Ok(false)
            }
            Change::AddPayee { payee } => {
                if self.payees.contains(payee) {
                    return Err("duplicate_payee");
                }
                if self.payees.len() as usize >= crate::envelope::MAX_PAYEES {
                    return Err("too_many_payees");
                }
                Ok(true)
            }
            Change::RemovePayee { payee } => {
                if self.payees.contains(payee) {
                    Ok(false)
                } else {
                    Err("payee_not_allowed")
                }
            }
            Change::Pause { spender } => match spender {
                None if self.paused => Err("no_change"),
                Some(s) if limits(s)?.paused => Err("no_change"),
                _ => Ok(false),
            },
            Change::Unpause { spender } => match spender {
                None if !self.paused => Err("no_change"),
                Some(s) if !limits(s)?.paused => Err("no_change"),
                _ => Ok(true),
            },
        }
    }

    /// Applies a validated change. Lowering a cap or ceiling also lowers the limits under it, so
    /// `auto_limit <= raise_ceiling <= one_approver_limit` and spender caps `<= period_cap` hold.
    pub fn apply(&mut self, change: &Change, now_ns: u64) {
        match change {
            Change::SpenderAutoLimit { spender, amount } => {
                self.update_spender(spender, |l| l.auto_limit = *amount);
            }
            Change::SpenderPeriodCap { spender, amount } => {
                self.update_spender(spender, |l| l.period_cap = *amount);
            }
            Change::PeriodCap { amount } => {
                self.period_cap = amount.0;
                self.clamp_spenders(|l| l.period_cap = U128(l.period_cap.0.min(amount.0)));
            }
            Change::OneApproverLimit { amount } => {
                self.one_approver_limit = amount.0;
                self.set_ceiling(self.raise_ceiling.min(amount.0));
            }
            Change::RaiseCeiling { amount } => self.set_ceiling(amount.0),
            Change::AddSpender {
                spender,
                auto_limit,
                period_cap,
            } => {
                self.roll_period(now_ns);
                let limits = SpenderLimits {
                    auto_limit: *auto_limit,
                    period_cap: *period_cap,
                    period_spent: U128(0),
                    period_start_ns: U64(self.period_start_ns),
                    open_escalations: 0,
                    paused: false,
                };
                self.spenders.insert(spender.clone(), limits);
            }
            Change::RemoveSpender { spender } => {
                self.spenders.remove(spender);
            }
            Change::AddApprover { approver } => {
                self.approvers.insert(approver.clone());
            }
            Change::RemoveApprover { approver } => {
                self.approvers.remove(approver);
            }
            Change::AddPayee { payee } => {
                self.payees.insert(payee.clone());
            }
            Change::RemovePayee { payee } => {
                self.payees.remove(payee);
            }
            Change::Pause { spender: None } => self.paused = true,
            Change::Unpause { spender: None } => self.paused = false,
            Change::Pause { spender: Some(s) } => self.update_spender(s, |l| l.paused = true),
            Change::Unpause { spender: Some(s) } => self.update_spender(s, |l| l.paused = false),
        }
    }

    fn set_ceiling(&mut self, ceiling: u128) {
        self.raise_ceiling = ceiling;
        self.clamp_spenders(|l| l.auto_limit = U128(l.auto_limit.0.min(ceiling)));
    }

    fn update_spender(&mut self, spender: &AccountId, f: impl FnOnce(&mut SpenderLimits)) {
        if let Some(limits) = self.spenders.get_mut(spender) {
            f(limits);
        }
    }

    fn clamp_spenders(&mut self, f: impl Fn(&mut SpenderLimits)) {
        for (_, limits) in self.spenders.iter_mut() {
            f(limits);
        }
    }
}
