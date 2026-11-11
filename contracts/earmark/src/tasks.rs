//! Funded tasks (bounties) and earned contributor trust.
//!
//! A lead posts a task; its amount is reserved in the budget at once. One approved payee claims
//! it and submits the work. The lead accepts, and the task becomes a normal request that goes
//! through the usual tiers, so the payment page, receipt and records work unchanged. A payee
//! with enough accepted, paid tasks in a budget is a trusted contributor there: the lead's
//! payments to them clear at once up to the budget's trusted limit (set by the DAO), instead of
//! waiting for an approver. Trust never skips the lead's acceptance.

use near_sdk::json_types::{U64, U128};
use near_sdk::store::Vector;
use near_sdk::{AccountId, CryptoHash, PromiseOrValue, env, near, require};

use crate::envelope::Envelope;
use crate::events::Event;
use crate::request::{
    BlockReason, MAX_REQUESTS_PER_PERIOD, MAX_TEXT_BYTES, Request, RequestCount, RequestStatus,
    SpendCheck, override_key, spender_key, work_key,
};
use crate::spend::{STORAGE_RESERVE, free_near};
use crate::{Contract, ContractExt, EnvelopeId, MAX_LIST_LIMIT, NANOS_PER_SEC, StorageKey};

/// Tasks holding a reservation per budget, so `close_envelope` can cancel them in one call.
pub const MAX_OPEN_TASKS: usize = 50;
pub const MAX_TITLE_BYTES: usize = 100;
const DEFAULT_CLAIM_DAYS: u32 = 7;
const MAX_CLAIM_DAYS: u32 = 30;
const SECS_PER_DAY: u64 = 86_400;
/// Open claims (claimed or submitted) per contributor per budget.
const MAX_OPEN_CLAIMS: usize = 1;
const MAX_OPEN_CLAIMS_TRUSTED: usize = 3;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    /// Posted and reserved; any allowed contributor can claim it.
    Open,
    /// One contributor is working on it until `claim_ends_ns`.
    Claimed,
    /// Work link sent; waiting for the lead.
    Submitted,
    /// The lead accepted; `request_id` is the payment, going through the tiers.
    Accepted,
    Paid,
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Task {
    pub envelope_id: U64,
    /// The spender who posted it, and the only one who can accept it.
    pub lead: AccountId,
    pub title: String,
    /// Link to the brief (may be empty).
    pub brief: String,
    pub amount: U128,
    /// Only this payee may claim it, if set.
    pub assignee: Option<AccountId>,
    pub claim_days: u32,
    pub status: TaskStatus,
    pub claimant: Option<AccountId>,
    pub claim_ends_ns: Option<U64>,
    pub work_ref: Option<String>,
    pub note: Option<String>,
    /// The payment made when the lead accepted (latest attempt).
    pub request_id: Option<String>,
    pub attempts: u32,
    pub created_at_ns: U64,
    /// Why it last moved back or ended (rejection reason, payment failure, cancel reason).
    pub reason: Option<String>,
}

/// Trust rules of one budget, set by the DAO. `trusted_limit` 0 turns trust off.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct TaskRules {
    /// A trusted contributor's payments clear at once up to this amount (≤ one-approver limit).
    pub trusted_limit: U128,
    /// Accepted, paid tasks needed in this budget.
    pub min_tasks: u32,
    /// Days since the first of them.
    pub min_days: u32,
    /// A for-cause rejection removes trust for this many days.
    pub strike_days: u32,
    /// Tasks below this amount don't count.
    pub min_task_amount: U128,
}

impl Default for TaskRules {
    fn default() -> Self {
        Self {
            trusted_limit: U128(0),
            min_tasks: 3,
            min_days: 14,
            strike_days: 90,
            min_task_amount: U128(0),
        }
    }
}

/// A contributor's task record in one budget: only tasks a lead accepted and that were paid.
#[near(serializers = [borsh, json])]
#[derive(Clone, Default)]
pub struct PayeeTrust {
    pub tasks_paid: u32,
    pub tasks_paid_total: U128,
    pub first_paid_at_ns: Option<U64>,
    pub last_strike_at_ns: Option<U64>,
}

#[near(serializers = [json])]
pub struct TrustView {
    pub record: PayeeTrust,
    pub trusted: bool,
    /// What a lead's payment to them can be without an approver (0 if not trusted).
    pub trusted_limit: U128,
}

/// Per budget: every task id (oldest first), the ones holding a reservation, and their total.
#[near]
pub struct TaskList {
    pub all: Vector<u64>,
    pub open: Vec<u64>,
    pub held: u128,
}

fn trust_key(envelope_id: EnvelopeId, payee: &AccountId) -> CryptoHash {
    let mut data = b"tt".to_vec();
    data.extend_from_slice(&envelope_id.to_le_bytes());
    data.extend_from_slice(payee.as_bytes());
    env::sha256_array(&data)
}

/// Leads and approvers of a budget can't claim its tasks.
fn on_team(envelope: &Envelope, account: &AccountId) -> bool {
    envelope.spenders.contains_key(account) || envelope.approvers.contains(account)
}

#[near]
impl Contract {
    /// A lead (spender) of the budget. Reserves `amount` from what's available. Tasks are paid
    /// from the budget, so `amount` can't exceed the one-approver limit; bigger work stays a
    /// normal request that goes to a DAO vote.
    pub fn post_task(
        &mut self,
        envelope_id: U64,
        title: String,
        brief: String,
        amount: U128,
        assignee: Option<AccountId>,
        claim_days: Option<u32>,
    ) -> U64 {
        let lead = env::predecessor_account_id();
        let id = envelope_id.0;
        let claim_days = claim_days.unwrap_or(DEFAULT_CLAIM_DAYS);
        require!(
            !title.trim().is_empty()
                && title.len() <= MAX_TITLE_BYTES
                && brief.len() <= MAX_TEXT_BYTES
                && (1..=MAX_CLAIM_DAYS).contains(&claim_days)
                && amount.0 > 0,
            BlockReason::InvalidInput.code()
        );
        let now = env::block_timestamp();
        let envelope = self
            .envelopes
            .get_mut(&id)
            .unwrap_or_else(|| env::panic_str("unknown_envelope"));
        envelope.roll_period(now);
        require!(!envelope.closed, "closed");
        let limits = envelope
            .spender_current(&lead)
            .unwrap_or_else(|| env::panic_str("not_spender"));
        require!(!envelope.paused && !limits.paused, "paused");
        require!(
            amount.0 <= envelope.one_approver_limit,
            "over_one_approver_limit"
        );
        require!(amount.0 <= envelope.available(), "over_available");
        if let Some(a) = &assignee {
            require!(envelope.payees.contains(a), "payee_not_allowed");
            require!(!on_team(envelope, a), "not_contributor");
        }
        require!(free_near() >= STORAGE_RESERVE, "insufficient_storage_float");
        envelope.committed += amount.0;
        let period_start_ns = envelope.period_start_ns;

        // Posting counts toward the spender's requests per period (R19), so a lead can't burn
        // the storage NEAR by posting and cancelling.
        let count = self.requests_this_period(id, &lead, period_start_ns);
        require!(count < MAX_REQUESTS_PER_PERIOD, "too_many_requests");
        self.request_counts.insert(
            spender_key(id, &lead),
            RequestCount {
                period_start_ns,
                count: count + 1,
            },
        );

        let task_id = self.next_task_id;
        self.next_task_id += 1;
        let list = self.task_list_mut(id);
        require!(list.open.len() < MAX_OPEN_TASKS, "too_many_open_tasks");
        list.all.push(task_id);
        list.open.push(task_id);
        list.held += amount.0;
        self.tasks.insert(
            task_id,
            Task {
                envelope_id,
                lead: lead.clone(),
                title,
                brief,
                amount,
                assignee,
                claim_days,
                status: TaskStatus::Open,
                claimant: None,
                claim_ends_ns: None,
                work_ref: None,
                note: None,
                request_id: None,
                attempts: 0,
                created_at_ns: U64(now),
                reason: None,
            },
        );
        Event::TaskPosted {
            task_id: U64(task_id),
            envelope_id,
            lead: &lead,
            amount,
        }
        .emit();
        U64(task_id)
    }

    /// An approved payee of the budget who isn't one of its leads or approvers. One open claim
    /// at a time, three for a trusted contributor.
    pub fn claim_task(&mut self, task_id: U64) {
        let who = env::predecessor_account_id();
        let mut task = self.task(task_id.0);
        require!(task.status == TaskStatus::Open, "not_open");
        let eid = task.envelope_id.0;
        let envelope = self.envelopes.get(&eid).unwrap();
        require!(!envelope.closed, "closed");
        require!(envelope.payees.contains(&who), "payee_not_allowed");
        require!(!on_team(envelope, &who), "not_contributor");
        if let Some(a) = &task.assignee {
            require!(a == &who, "assigned_to_other");
        }
        let max = if self.is_trusted(eid, &who) {
            MAX_OPEN_CLAIMS_TRUSTED
        } else {
            MAX_OPEN_CLAIMS
        };
        require!(self.open_claims(eid, &who) < max, "too_many_claims");

        let ends = env::block_timestamp()
            .saturating_add(u64::from(task.claim_days) * SECS_PER_DAY * NANOS_PER_SEC);
        task.status = TaskStatus::Claimed;
        task.claimant = Some(who.clone());
        task.claim_ends_ns = Some(U64(ends));
        task.reason = None;
        self.tasks.insert(task_id.0, task);
        Event::TaskClaimed {
            task_id,
            claimant: &who,
        }
        .emit();
    }

    /// Opens a claimed task again. The claimant, the lead, an approver or the DAO at any time;
    /// anyone once the claim's deadline has passed.
    pub fn release_claim(&mut self, task_id: U64) {
        let who = env::predecessor_account_id();
        let mut task = self.task(task_id.0);
        require!(task.status == TaskStatus::Claimed, "not_claimed");
        let expired = task
            .claim_ends_ns
            .is_some_and(|e| env::block_timestamp() >= e.0);
        require!(
            expired || task.claimant.as_ref() == Some(&who) || self.can_review(&task, &who),
            "not_allowed"
        );
        task.reason = Some(if expired { "claim_expired" } else { "released" }.to_owned());
        reopen(&mut task);
        self.tasks.insert(task_id.0, task);
        Event::ClaimReleased { task_id, by: &who }.emit();
    }

    /// The claimant. The same work link can't be paid twice for them in this budget.
    pub fn submit_work(&mut self, task_id: U64, work_ref: String, note: Option<String>) {
        let who = env::predecessor_account_id();
        let mut task = self.task(task_id.0);
        require!(task.status == TaskStatus::Claimed, "not_claimed");
        require!(task.claimant.as_ref() == Some(&who), "not_claimant");
        require!(
            !work_ref.trim().is_empty()
                && work_ref.len() <= MAX_TEXT_BYTES
                && note.as_ref().is_none_or(|n| n.len() <= MAX_TEXT_BYTES),
            BlockReason::InvalidInput.code()
        );
        let work = work_key(task.envelope_id.0, &who, &work_ref);
        require!(
            !self.work_claims.contains_key(&work)
                || self
                    .work_overrides
                    .contains_key(&override_key(&work, &task.lead)),
            BlockReason::DuplicateWork.code()
        );
        task.status = TaskStatus::Submitted;
        task.work_ref = Some(work_ref);
        task.note = note;
        task.reason = None;
        Event::WorkSubmitted {
            task_id,
            work_ref: task.work_ref.as_deref().unwrap_or_default(),
        }
        .emit();
        self.tasks.insert(task_id.0, task);
    }

    /// The lead, an approver or the DAO. A plain rejection sends the work back to the same
    /// contributor with a fresh deadline. `for_cause` reopens the task for others and counts
    /// against the contributor's trust in this budget.
    pub fn reject_work(&mut self, task_id: U64, reason: String, for_cause: bool) {
        let who = env::predecessor_account_id();
        require!(
            !reason.trim().is_empty() && reason.len() <= MAX_TEXT_BYTES,
            "invalid_reason"
        );
        let mut task = self.task(task_id.0);
        require!(task.status == TaskStatus::Submitted, "not_submitted");
        require!(self.can_review(&task, &who), "not_allowed");
        let claimant = task.claimant.clone().unwrap();
        if for_cause {
            let key = trust_key(task.envelope_id.0, &claimant);
            let mut trust = self.trust.get(&key).cloned().unwrap_or_default();
            trust.last_strike_at_ns = Some(U64(env::block_timestamp()));
            self.trust.insert(key, trust);
            reopen(&mut task);
        } else {
            let ends = env::block_timestamp()
                .saturating_add(u64::from(task.claim_days) * SECS_PER_DAY * NANOS_PER_SEC);
            task.status = TaskStatus::Claimed;
            task.claim_ends_ns = Some(U64(ends));
            task.work_ref = None;
            task.note = None;
        }
        task.reason = Some(reason.clone());
        self.tasks.insert(task_id.0, task);
        Event::WorkRejected {
            task_id,
            by: &who,
            contributor: &claimant,
            reason: &reason,
            for_cause,
        }
        .emit();
    }

    /// The lead who posted it. The task's reservation is freed and the payment is made as a
    /// normal request in the lead's name, with every rule checked again (payee still allowed,
    /// not paused, period caps, same work not paid). The tier follows the lead's limit, or the
    /// trusted limit if the contributor is trusted here.
    pub fn accept_task(&mut self, task_id: U64) -> PromiseOrValue<RequestStatus> {
        let lead = env::predecessor_account_id();
        let mut task = self.task(task_id.0);
        require!(task.status == TaskStatus::Submitted, "not_submitted");
        require!(task.lead == lead, "not_lead");
        let eid = task.envelope_id.0;
        let amount = task.amount;
        let payee = task.claimant.clone().unwrap();
        let work_ref = task.work_ref.clone().unwrap();
        task.attempts += 1;
        let request_id = format!("task-{}-{}", task_id.0, task.attempts);

        let envelope = self.envelopes.get_mut(&eid).unwrap();
        envelope.roll_period(env::block_timestamp());
        envelope.committed -= amount.0;
        self.unhold(eid, task_id.0, amount.0);
        // Any failure below panics and reverts the freed reservation too.
        let tier = self
            .evaluate(eid, &lead, &request_id, &payee, amount.0, &work_ref)
            .unwrap_or_else(|reason| env::panic_str(reason.code()));

        task.status = TaskStatus::Accepted;
        task.request_id = Some(request_id.clone());
        task.reason = None;
        let memo = task.title.clone();
        self.tasks.insert(task_id.0, task);
        self.task_requests.insert(request_id.clone(), task_id.0);
        Event::TaskAccepted {
            task_id,
            request_id: &request_id,
        }
        .emit();
        self.create_request(
            lead,
            U64(eid),
            request_id,
            payee,
            amount,
            memo,
            work_ref,
            None,
            tier,
        )
    }

    /// Frees the reservation. The lead while nobody has submitted work; an approver or the DAO
    /// also after (for example when the lead is gone).
    pub fn cancel_task(&mut self, task_id: U64, reason: String) {
        let who = env::predecessor_account_id();
        require!(
            !reason.trim().is_empty() && reason.len() <= MAX_TEXT_BYTES,
            "invalid_reason"
        );
        let mut task = self.task(task_id.0);
        let envelope = self.envelopes.get(&task.envelope_id.0).unwrap();
        let reviewer = envelope.approvers.contains(&who) || who == self.dao_id;
        let allowed = match task.status {
            TaskStatus::Open | TaskStatus::Claimed => reviewer || who == task.lead,
            TaskStatus::Submitted => reviewer,
            _ => env::panic_str("not_cancellable"),
        };
        require!(allowed, "not_allowed");
        let eid = task.envelope_id.0;
        self.envelopes.get_mut(&eid).unwrap().committed -= task.amount.0;
        self.unhold(eid, task_id.0, task.amount.0);
        task.status = TaskStatus::Cancelled;
        task.reason = Some(reason.clone());
        self.tasks.insert(task_id.0, task);
        Event::TaskCancelled {
            task_id,
            by: &who,
            reason: &reason,
        }
        .emit();
    }

    /// DAO only, through a `FunctionCall` proposal. Turns trust on (`trusted_limit` > 0) or off
    /// for a budget and sets what earns it.
    pub fn set_task_rules(&mut self, envelope_id: U64, rules: TaskRules) {
        self.assert_dao();
        let envelope = self
            .envelopes
            .get(&envelope_id.0)
            .unwrap_or_else(|| env::panic_str("unknown_envelope"));
        require!(
            rules.trusted_limit.0 <= envelope.one_approver_limit,
            "over_one_approver_limit"
        );
        require!(
            rules.min_tasks >= 1 && rules.min_days <= 365 && rules.strike_days <= 3650,
            BlockReason::InvalidInput.code()
        );
        Event::TaskRulesSet {
            envelope_id,
            rules: &rules,
        }
        .emit();
        self.task_rules.insert(envelope_id.0, rules);
    }

    pub fn get_task(&self, task_id: U64) -> Option<Task> {
        self.tasks.get(&task_id.0).cloned()
    }

    /// A budget's tasks, newest first. `from_index` counts from the newest.
    pub fn list_tasks(
        &self,
        envelope_id: U64,
        from_index: Option<U64>,
        limit: Option<u32>,
    ) -> Vec<(U64, Task)> {
        let Some(list) = self.task_lists.get(&envelope_id.0) else {
            return vec![];
        };
        let limit = limit.unwrap_or(MAX_LIST_LIMIT).min(MAX_LIST_LIMIT) as usize;
        list.all
            .iter()
            .rev()
            .skip(from_index.map_or(0, |i| i.0) as usize)
            .take(limit)
            .filter_map(|id| Some((U64(*id), self.tasks.get(id)?.clone())))
            .collect()
    }

    pub fn get_task_rules(&self, envelope_id: U64) -> TaskRules {
        self.task_rules
            .get(&envelope_id.0)
            .cloned()
            .unwrap_or_default()
    }

    pub fn get_contributor_trust(&self, envelope_id: U64, account_id: AccountId) -> TrustView {
        let record = self
            .trust
            .get(&trust_key(envelope_id.0, &account_id))
            .cloned()
            .unwrap_or_default();
        let trusted = self.is_trusted(envelope_id.0, &account_id);
        TrustView {
            record,
            trusted,
            trusted_limit: U128(self.trusted_limit(envelope_id.0, &account_id)),
        }
    }

    /// What accepting a submitted task would do now (the tier, or why it's blocked), as
    /// `accept_task` checks it.
    pub fn check_accept(&self, task_id: U64) -> SpendCheck {
        let checked = match self.tasks.get(&task_id.0) {
            Some(task) if task.status == TaskStatus::Submitted => self.evaluate_with(
                task.envelope_id.0,
                &task.lead,
                &format!("task-{}-{}", task_id.0, task.attempts + 1),
                task.claimant.as_ref().unwrap(),
                task.amount.0,
                task.work_ref.as_deref().unwrap_or_default(),
                task.amount.0,
            ),
            _ => Err(BlockReason::InvalidInput),
        };
        match checked {
            Ok(tier) => SpendCheck {
                tier: Some(tier),
                blocked: None,
            },
            Err(reason) => SpendCheck {
                tier: None,
                blocked: Some(reason),
            },
        }
    }
}

/// Back to `Open`: no claimant, no work.
fn reopen(task: &mut Task) {
    task.status = TaskStatus::Open;
    task.claimant = None;
    task.claim_ends_ns = None;
    task.work_ref = None;
    task.note = None;
}

impl Contract {
    fn task(&self, task_id: u64) -> Task {
        self.tasks
            .get(&task_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown_task"))
    }

    /// The lead who posted it, an approver of its budget, or the DAO.
    fn can_review(&self, task: &Task, who: &AccountId) -> bool {
        who == &task.lead
            || who == &self.dao_id
            || self
                .envelopes
                .get(&task.envelope_id.0)
                .is_some_and(|e| e.approvers.contains(who))
    }

    fn task_list_mut(&mut self, envelope_id: EnvelopeId) -> &mut TaskList {
        if !self.task_lists.contains_key(&envelope_id) {
            self.task_lists.insert(
                envelope_id,
                TaskList {
                    all: Vector::new(StorageKey::EnvelopeTasks { envelope_id }),
                    open: Vec::new(),
                    held: 0,
                },
            );
        }
        self.task_lists.get_mut(&envelope_id).unwrap()
    }

    /// Takes a task off the reserved list. The caller has already lowered `committed`.
    fn unhold(&mut self, envelope_id: EnvelopeId, task_id: u64, amount: u128) {
        let list = self.task_list_mut(envelope_id);
        list.open.retain(|t| *t != task_id);
        list.held -= amount;
    }

    /// Tasks claimed or submitted by `who` in a budget.
    fn open_claims(&self, envelope_id: EnvelopeId, who: &AccountId) -> usize {
        self.task_lists.get(&envelope_id).map_or(0, |list| {
            list.open
                .iter()
                .filter_map(|id| self.tasks.get(id))
                .filter(|t| {
                    t.claimant.as_ref() == Some(who)
                        && matches!(t.status, TaskStatus::Claimed | TaskStatus::Submitted)
                })
                .count()
        })
    }

    pub(crate) fn is_trusted(&self, envelope_id: EnvelopeId, payee: &AccountId) -> bool {
        let Some(rules) = self.task_rules.get(&envelope_id) else {
            return false;
        };
        let Some(trust) = self.trust.get(&trust_key(envelope_id, payee)) else {
            return false;
        };
        let now = env::block_timestamp();
        let days = |d: u32| u64::from(d) * SECS_PER_DAY * NANOS_PER_SEC;
        rules.trusted_limit.0 > 0
            && trust.tasks_paid >= rules.min_tasks
            && trust
                .first_paid_at_ns
                .is_some_and(|f| now.saturating_sub(f.0) >= days(rules.min_days))
            && trust
                .last_strike_at_ns
                .is_none_or(|s| now.saturating_sub(s.0) >= days(rules.strike_days))
    }

    /// The trusted limit for `payee` in a budget, or 0.
    pub(crate) fn trusted_limit(&self, envelope_id: EnvelopeId, payee: &AccountId) -> u128 {
        if self.is_trusted(envelope_id, payee) {
            self.task_rules
                .get(&envelope_id)
                .map_or(0, |r| r.trusted_limit.0)
        } else {
            0
        }
    }

    /// Called when a request reaches its outcome. For a task's payment: paid → the task is
    /// paid and counts for the contributor's trust; failed, rejected, expired or closed by the
    /// DAO → the task goes back to `submitted` with its reservation, so the lead can try again
    /// or cancel it. If the budget closed or the money is gone meanwhile, it's cancelled.
    pub(crate) fn task_settled(&mut self, request_id: &str, request: &Request, paid: bool) {
        let Some(task_id) = self.task_requests.get(request_id).copied() else {
            return;
        };
        let mut task = self.task(task_id);
        if task.status != TaskStatus::Accepted {
            return;
        }
        let eid = task.envelope_id.0;
        let amount = task.amount.0;
        if paid {
            task.status = TaskStatus::Paid;
            let rules = self.get_task_rules(task.envelope_id);
            if amount >= rules.min_task_amount.0 {
                let key = trust_key(eid, &request.payee);
                let mut trust = self.trust.get(&key).cloned().unwrap_or_default();
                trust.tasks_paid += 1;
                trust.tasks_paid_total = U128(trust.tasks_paid_total.0.saturating_add(amount));
                trust
                    .first_paid_at_ns
                    .get_or_insert(U64(env::block_timestamp()));
                self.trust.insert(key, trust);
            }
        } else {
            let envelope = self.envelopes.get_mut(&eid).unwrap();
            let open = self.task_lists.get(&eid).map_or(0, |l| l.open.len());
            if envelope.closed || envelope.available() < amount || open >= MAX_OPEN_TASKS {
                task.status = TaskStatus::Cancelled;
                task.reason = Some(
                    if envelope.closed {
                        "closed"
                    } else {
                        "funds_gone"
                    }
                    .to_owned(),
                );
            } else {
                envelope.committed += amount;
                let list = self.task_list_mut(eid);
                list.open.push(task_id);
                list.held += amount;
                task.status = TaskStatus::Submitted;
                task.reason = request.failure.clone();
            }
        }
        let status = task.status;
        self.tasks.insert(task_id, task);
        Event::TaskSettled {
            task_id: U64(task_id),
            request_id,
            status,
        }
        .emit();
    }

    /// `close_envelope`: cancels every task still holding a reservation. Returns how many.
    pub(crate) fn cancel_open_tasks(&mut self, envelope_id: EnvelopeId) -> u32 {
        let Some(list) = self.task_lists.get_mut(&envelope_id) else {
            return 0;
        };
        let open = std::mem::take(&mut list.open);
        let held = std::mem::take(&mut list.held);
        self.envelopes.get_mut(&envelope_id).unwrap().committed -= held;
        let dao = self.dao_id.clone();
        for task_id in &open {
            let mut task = self.task(*task_id);
            task.status = TaskStatus::Cancelled;
            task.reason = Some("closed".to_owned());
            self.tasks.insert(*task_id, task);
            Event::TaskCancelled {
                task_id: U64(*task_id),
                by: &dao,
                reason: "closed",
            }
            .emit();
        }
        open.len() as u32
    }
}
