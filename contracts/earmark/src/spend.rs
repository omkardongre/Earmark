//! `check_spend` / `request_spend`, payment of the auto tier and escalation to a DAO proposal.

use near_contract_standards::fungible_token::core::ext_ft_core;
use near_sdk::json_types::{U64, U128};
use near_sdk::serde_json::{self, json};
use near_sdk::{
    AccountId, Gas, NearToken, Promise, PromiseError, PromiseOrValue, env, ext_contract, log, near,
    require,
};

use crate::envelope::MAX_PENDING;
use crate::events::Event;
use crate::request::{
    BlockReason, MAX_OPEN_ESCALATIONS, MAX_REQUESTS_PER_PERIOD, PayeeRecord, Record, Request,
    RequestCount, RequestStatus, SpendCheck, Tier, escalation_description, override_key,
    spender_key, tier_for, valid_text, work_key,
};
use crate::{Contract, ContractExt, EnvelopeId, MAX_LIST_LIMIT};

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_ON_PAID: Gas = Gas::from_tgas(10);
const GAS_GET_POLICY: Gas = Gas::from_tgas(10);
const GAS_ADD_PROPOSAL: Gas = Gas::from_tgas(20);
const GAS_ON_ESCALATED: Gas = Gas::from_tgas(10);
const GAS_ON_POLICY: Gas = Gas::from_tgas(45);
const GAS_GET_PROPOSAL: Gas = Gas::from_tgas(10);
const GAS_ON_SETTLE: Gas = Gas::from_tgas(15);
const GAS_ON_DAO_PAYOUT: Gas = Gas::from_tgas(8);
/// Kept free in `ft_on_transfer` before it pays out the DAO's money in the same transaction.
const GAS_DAO_PAYOUT_MARGIN: Gas = Gas::from_tgas(4);
/// R22: blocks after the approving vote before `settle_escalation` trusts a proposal that is
/// still `Approved` (Sputnik runs the transfer a block or two after the vote, and turns the
/// proposal `Failed` if it fails). About 11 s.
pub const SETTLE_WAIT_BLOCKS: u64 = 20;
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// NEAR kept back from the bond float for the contract's own storage growth.
pub(crate) const STORAGE_RESERVE: NearToken = NearToken::from_millinear(500);

#[ext_contract(ext_dao)]
#[allow(dead_code)]
trait SputnikDao {
    fn get_policy(&self) -> serde_json::Value;
    fn get_proposal(&self, id: u64) -> serde_json::Value;
    fn add_proposal(&mut self, proposal: serde_json::Value) -> u64;
}

#[near]
impl Contract {
    /// Which tier a request would take, or why it would be blocked. Advisory: `request_spend`
    /// runs the same checks again.
    #[allow(clippy::too_many_arguments)]
    pub fn check_spend(
        &self,
        envelope_id: U64,
        spender: AccountId,
        request_id: String,
        payee: AccountId,
        amount: U128,
        work_ref: String,
    ) -> SpendCheck {
        // Same text limits `request_spend` enforces first (memo and receipt aren't known here).
        let checked = if valid_text(&request_id, &work_ref, "", None) {
            self.evaluate(
                envelope_id.0,
                &spender,
                &request_id,
                &payee,
                amount.0,
                &work_ref,
            )
        } else {
            Err(BlockReason::InvalidInput)
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

    /// Spender only. No deposit, so a function-call key can call it. Fails with the same
    /// reason code `check_spend` returns.
    #[allow(clippy::too_many_arguments)]
    pub fn request_spend(
        &mut self,
        envelope_id: U64,
        request_id: String,
        payee: AccountId,
        amount: U128,
        memo: String,
        work_ref: String,
        receipt: Option<String>,
    ) -> PromiseOrValue<RequestStatus> {
        let spender = env::predecessor_account_id();
        require!(
            valid_text(&request_id, &work_ref, &memo, receipt.as_deref()),
            BlockReason::InvalidInput.code()
        );
        let now = env::block_timestamp();
        let id = envelope_id.0;
        self.envelopes
            .get_mut(&id)
            .unwrap_or_else(|| env::panic_str("unknown_envelope"))
            .roll_period(now);

        let tier = self
            .evaluate(id, &spender, &request_id, &payee, amount.0, &work_ref)
            .unwrap_or_else(|reason| env::panic_str(reason.code()));
        self.create_request(
            spender,
            envelope_id,
            request_id,
            payee,
            amount,
            memo,
            work_ref,
            receipt,
            tier,
        )
    }
}

impl Contract {
    /// Records a request that `evaluate` allowed with `tier`, reserves or pays it, and starts
    /// its tier's flow. Shared by `request_spend` and `accept_task`; the caller has rolled the
    /// period and run `evaluate` in the same call.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn create_request(
        &mut self,
        spender: AccountId,
        envelope_id: U64,
        request_id: String,
        payee: AccountId,
        amount: U128,
        memo: String,
        work_ref: String,
        receipt: Option<String>,
        tier: Tier,
    ) -> PromiseOrValue<RequestStatus> {
        let now = env::block_timestamp();
        let id = envelope_id.0;
        let envelope = self.envelopes.get_mut(&id).unwrap();
        let period_start_ns = envelope.period_start_ns;
        let mut limits = envelope.spender_current(&spender).unwrap();
        let status = match tier {
            Tier::Auto | Tier::Trusted => {
                envelope.in_flight += amount.0;
                RequestStatus::Paying
            }
            Tier::OneApprover => {
                envelope.committed += amount.0;
                RequestStatus::PendingApproval
            }
            Tier::Escalate => {
                limits.open_escalations += 1;
                RequestStatus::Escalating
            }
        };
        if tier != Tier::Escalate {
            envelope.period_spent += amount.0;
            limits.period_spent = U128(limits.period_spent.0 + amount.0);
        }
        envelope.spenders.insert(spender.clone(), limits);
        if tier == Tier::OneApprover {
            envelope.pending.insert(request_id.clone());
        }
        let token_id = envelope.token_id.clone();
        let count = self.requests_this_period(id, &spender, period_start_ns);
        self.request_counts.insert(
            spender_key(id, &spender),
            RequestCount {
                period_start_ns,
                count: count + 1,
            },
        );

        let work = work_key(id, &payee, &work_ref);
        if self.work_claims.contains_key(&work) {
            // evaluate() let a repeat through only with an override; it is used up here. The
            // claim stays with the earlier request.
            self.work_overrides.remove(&override_key(&work, &spender));
        } else {
            self.work_claims.insert(work, request_id.clone());
        }
        let request = Request {
            envelope_id,
            spender: spender.clone(),
            payee: payee.clone(),
            amount,
            memo,
            work_ref,
            receipt,
            tier,
            status,
            period_start_ns: U64(period_start_ns),
            created_at_ns: U64(now),
            decided_by: None,
            dao_proposal_id: None,
            failure: None,
        };
        Event::SpendRequested {
            request_id: &request_id,
            envelope_id,
            spender: &spender,
            payee: &payee,
            amount,
            tier,
        }
        .emit();

        let memo = format!("earmark {request_id}");
        self.envelopes
            .get_mut(&id)
            .unwrap()
            .requests
            .push(request_id.clone());
        self.requests.insert(request_id.clone(), request);
        match tier {
            Tier::Auto | Tier::Trusted => self
                .pay(&token_id, &request_id, &payee, amount, memo)
                .into(),
            Tier::OneApprover => PromiseOrValue::Value(RequestStatus::PendingApproval),
            Tier::Escalate => ext_dao::ext(self.dao_id.clone())
                .with_static_gas(GAS_GET_POLICY)
                .get_policy()
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_ON_POLICY)
                        .on_policy(request_id),
                )
                .into(),
        }
    }
}

#[near]
impl Contract {
    pub fn get_request(&self, request_id: String) -> Option<Request> {
        self.requests.get(&request_id).cloned()
    }

    /// A budget's requests, newest first. `from_index` counts from the newest.
    pub fn list_requests(
        &self,
        envelope_id: U64,
        from_index: Option<U64>,
        limit: Option<u32>,
    ) -> Vec<(String, Request)> {
        let Some(envelope) = self.envelopes.get(&envelope_id.0) else {
            return vec![];
        };
        let limit = limit.unwrap_or(MAX_LIST_LIMIT).min(MAX_LIST_LIMIT) as usize;
        let skip = from_index.map_or(0, |i| i.0) as usize;
        envelope
            .requests
            .iter()
            .rev()
            .skip(skip)
            .take(limit)
            .filter_map(|id| Some((id.clone(), self.requests.get(id)?.clone())))
            .collect()
    }

    /// The spender's record across budgets (R9 reads it).
    pub fn get_record(&self, account_id: AccountId) -> Record {
        self.records.get(&account_id).cloned().unwrap_or_default()
    }

    /// What a payee has been paid across budgets (R21).
    pub fn get_payee_record(&self, account_id: AccountId) -> PayeeRecord {
        self.payee_records
            .get(&account_id)
            .cloned()
            .unwrap_or_default()
    }

    /// Anyone (R18, R22).
    /// - `dao_funded` (the DAO's money is held here): pays the payee; `paid_by_dao` on success.
    /// - `escalated`: reads the DAO proposal and policy. Rejected, removed, expired, moved or
    ///   not found → `escalation_closed`. Approved but its money never reached Earmark
    ///   (`SETTLE_WAIT_BLOCKS` after the vote) → `escalation_closed` (`dao_payment_returned`).
    ///   A proposal filed before R22 that paid the payee directly → `paid_by_dao` once it has
    ///   stayed approved that long. Still being voted on → no change.
    pub fn settle_escalation(&mut self, request_id: String) -> Promise {
        let request = self
            .requests
            .get(&request_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown_request"));
        if request.status == RequestStatus::DaoFunded {
            let token_id = self.envelope_token(&request);
            return self.pay_from_dao(&token_id, &request_id, request);
        }
        require!(request.status == RequestStatus::Escalated, "not_escalated");
        let proposal_id = request
            .dao_proposal_id
            .unwrap_or_else(|| env::panic_str("no_proposal_id"));
        ext_dao::ext(self.dao_id.clone())
            .with_static_gas(GAS_GET_PROPOSAL)
            .get_proposal(proposal_id.0)
            .and(
                ext_dao::ext(self.dao_id.clone())
                    .with_static_gas(GAS_GET_POLICY)
                    .get_policy(),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_SETTLE)
                    .on_settle(request_id),
            )
    }

    /// Never panics on the results. Settling twice changes nothing: only `escalated` requests
    /// move on.
    #[private]
    pub fn on_settle(
        &mut self,
        request_id: String,
        #[callback_result] proposal: Result<serde_json::Value, PromiseError>,
        #[callback_result] policy: Result<serde_json::Value, PromiseError>,
    ) -> RequestStatus {
        let request = self.requests.get(&request_id).cloned().unwrap();
        if request.status != RequestStatus::Escalated {
            return request.status;
        }
        let outcome = match &proposal {
            // Sputnik panics with ERR_NO_PROPOSAL once a proposal is removed (spam vote, or a
            // Trezu Requestor deleting it).
            Err(_) => Some("removed"),
            Ok(p) => match p.get("status").and_then(|s| s.as_str()) {
                Some("Approved") => approved_outcome(p),
                Some("Rejected") => Some("rejected"),
                Some("Removed") => Some("removed"),
                Some("Expired") => Some("expired"),
                Some("Moved") => Some("moved"),
                // Past the voting period it can only finalize as expired.
                Some("InProgress" | "Failed") if past_vote_period(p, policy.as_ref().ok()) => {
                    Some("expired")
                }
                _ => None,
            },
        };
        let Some(outcome) = outcome else {
            return RequestStatus::Escalated;
        };
        Event::EscalationSettled {
            request_id: &request_id,
            dao_proposal_id: request.dao_proposal_id,
            outcome,
        }
        .emit();
        if outcome == "approved" {
            // Only a proposal filed before R22, which paid the payee directly.
            self.free_escalation_slot(&request);
            self.count_payment(&request);
            Event::SpendPaid {
                request_id: &request_id,
                payee: &request.payee,
                amount: request.amount,
            }
            .emit();
            let mut request = request;
            request.status = RequestStatus::PaidByDao;
            self.requests.insert(request_id, request);
            RequestStatus::PaidByDao
        } else {
            self.release(
                &request_id,
                request,
                RequestStatus::EscalationClosed,
                Some(outcome),
            );
            RequestStatus::EscalationClosed
        }
    }

    #[private]
    pub fn on_paid(
        &mut self,
        request_id: String,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> RequestStatus {
        let request = self.requests.get(&request_id).cloned().unwrap();
        let id = request.envelope_id.0;
        let amount = request.amount.0;
        let envelope = self.envelopes.get_mut(&id).unwrap();
        envelope.in_flight -= amount;
        if result.is_ok() {
            envelope.balance -= amount;
            envelope.spent_total += amount;
            self.settle_paid(&request_id, request);
            RequestStatus::Paid
        } else {
            self.settle_failed(&request_id, request, "transfer_failed");
            RequestStatus::Failed
        }
    }

    /// R22: result of paying the DAO's money to the payee. Success → `paid_by_dao`, counted for
    /// the spender and payee. Failure → back to `dao_funded`, money still held, so anyone can
    /// retry with `settle_escalation` (for example after the payee registers with the token).
    #[private]
    pub fn on_dao_payout(
        &mut self,
        request_id: String,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> RequestStatus {
        let mut request = self.requests.get(&request_id).cloned().unwrap();
        if request.status != RequestStatus::Paying {
            return request.status;
        }
        if result.is_ok() {
            self.free_escalation_slot(&request);
            self.count_payment(&request);
            Event::SpendPaid {
                request_id: &request_id,
                payee: &request.payee,
                amount: request.amount,
            }
            .emit();
            request.status = RequestStatus::PaidByDao;
            request.failure = None;
            self.task_settled(&request_id, &request, true);
        } else {
            Event::DaoPayoutFailed {
                request_id: &request_id,
            }
            .emit();
            request.status = RequestStatus::DaoFunded;
            request.failure = Some("payout_failed".to_owned());
        }
        let status = request.status;
        self.requests.insert(request_id, request);
        status
    }

    /// DAO only, through a `FunctionCall` proposal (R22). Sends the money held for a
    /// `dao_funded` request back to the DAO and closes the request, freeing its work claim.
    /// For a payout that keeps failing.
    pub fn return_escalation(&mut self, request_id: String) -> Promise {
        self.assert_dao();
        let mut request = self
            .requests
            .get(&request_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown_request"));
        require!(request.status == RequestStatus::DaoFunded, "not_dao_funded");
        let token_id = self.envelope_token(&request);
        let amount = request.amount;
        request.status = RequestStatus::Paying;
        self.requests.insert(request_id.clone(), request);
        ext_ft_core::ext(token_id)
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(
                self.dao_id.clone(),
                amount,
                Some(format!("earmark return {request_id}")),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_DAO_PAYOUT)
                    .on_dao_return(request_id),
            )
    }

    #[private]
    pub fn on_dao_return(
        &mut self,
        request_id: String,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> RequestStatus {
        let mut request = self.requests.get(&request_id).cloned().unwrap();
        if request.status != RequestStatus::Paying {
            return request.status;
        }
        if result.is_ok() {
            Event::DaoFundsReturned {
                request_id: &request_id,
                amount: request.amount,
            }
            .emit();
            self.release(
                &request_id,
                request,
                RequestStatus::EscalationClosed,
                Some("returned_to_dao"),
            );
            RequestStatus::EscalationClosed
        } else {
            request.status = RequestStatus::DaoFunded;
            self.requests.insert(request_id, request);
            RequestStatus::DaoFunded
        }
    }

    /// Reads the DAO's bond and files the Transfer proposal, paying the bond from this
    /// contract's own NEAR. Sputnik returns the bond after the vote (or after expiry and
    /// finalize); it keeps it only if the proposal is removed as spam.
    #[private]
    pub fn on_policy(
        &mut self,
        request_id: String,
        #[callback_result] policy: Result<serde_json::Value, PromiseError>,
    ) -> PromiseOrValue<RequestStatus> {
        let request = self.requests.get(&request_id).cloned().unwrap();
        let bond = policy
            .ok()
            .and_then(|p| p.get("proposal_bond")?.as_str()?.parse::<u128>().ok())
            .map(NearToken::from_yoctonear);
        let Some(bond) = bond else {
            self.settle_failed(&request_id, request, "dao_policy_unreadable");
            return PromiseOrValue::Value(RequestStatus::Failed);
        };
        if !self.can_pay_bond(bond) {
            self.settle_failed(&request_id, request, "insufficient_bond_float");
            return PromiseOrValue::Value(RequestStatus::Failed);
        }

        let token_id = self
            .envelopes
            .get(&request.envelope_id.0)
            .unwrap()
            .token_id
            .clone();
        let description = escalation_description(
            &request_id,
            request.envelope_id.0,
            &request.spender,
            &request.payee,
            &request.memo,
            &request.work_ref,
        );
        // R22: the DAO sends the money to Earmark with the request id (`ft_transfer_call`), and
        // Earmark pays the payee, so the payment is confirmed by Earmark's own transfer.
        let proposal = json!({
            "description": description,
            "kind": { "Transfer": {
                "token_id": token_id,
                "receiver_id": env::current_account_id(),
                "amount": request.amount,
                "msg": json!({ "request_id": request_id }).to_string(),
            }},
        });
        ext_dao::ext(self.dao_id.clone())
            .with_attached_deposit(bond)
            .with_static_gas(GAS_ADD_PROPOSAL)
            .add_proposal(proposal)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_ESCALATED)
                    .on_escalated(request_id),
            )
            .into()
    }

    /// Callbacks never panic on the result: a panic here would roll back this callback and
    /// leave the request stuck in `escalating`. Sputnik returns the proposal id as a JSON number.
    #[private]
    pub fn on_escalated(
        &mut self,
        request_id: String,
        #[callback_result] proposal_id: Result<serde_json::Value, PromiseError>,
    ) -> RequestStatus {
        let mut request = self.requests.get(&request_id).cloned().unwrap();
        match proposal_id {
            Ok(value) => {
                let proposal_id = value
                    .as_u64()
                    .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
                    .map(U64);
                // The proposal exists even if its id can't be read; the app finds it by the
                // request id in its description.
                if proposal_id.is_none() {
                    log!(
                        "escalation {}: unreadable proposal id {}",
                        request_id,
                        value
                    );
                }
                request.status = RequestStatus::Escalated;
                request.dao_proposal_id = proposal_id;
                Event::SpendEscalated {
                    request_id: &request_id,
                    dao_proposal_id: proposal_id,
                }
                .emit();
                self.requests.insert(request_id, request);
                RequestStatus::Escalated
            }
            Err(_) => {
                // A failed add_proposal refunds the attached bond to this contract.
                self.settle_failed(&request_id, request, "dao_proposal_failed");
                RequestStatus::Failed
            }
        }
    }
}

impl Contract {
    /// Check order R17, shared by `check_spend` and `request_spend`.
    pub(crate) fn evaluate(
        &self,
        envelope_id: EnvelopeId,
        spender: &AccountId,
        request_id: &str,
        payee: &AccountId,
        amount: u128,
        work_ref: &str,
    ) -> Result<Tier, BlockReason> {
        self.evaluate_with(envelope_id, spender, request_id, payee, amount, work_ref, 0)
    }

    /// `evaluate`, counting `held` as available too: the reservation of the task being
    /// accepted, which `accept_task` frees before it runs these checks.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn evaluate_with(
        &self,
        envelope_id: EnvelopeId,
        spender: &AccountId,
        request_id: &str,
        payee: &AccountId,
        amount: u128,
        work_ref: &str,
        held: u128,
    ) -> Result<Tier, BlockReason> {
        let envelope = self
            .envelopes
            .get(&envelope_id)
            .ok_or(BlockReason::Closed)?;
        // 1. closed / paused / not_spender / duplicate_request
        if envelope.closed {
            return Err(BlockReason::Closed);
        }
        let mut limits = envelope
            .spender_current(spender)
            .ok_or(BlockReason::NotSpender)?;
        // A view runs before anything rolls the period: count a period that has ended as empty,
        // as `request_spend` does after `roll_period`.
        let period_start = envelope.current_period_start(env::block_timestamp());
        let mut period_spent = envelope.period_spent;
        if period_start != envelope.period_start_ns {
            period_spent = 0;
            limits.period_spent = U128(0);
        }
        if envelope.paused || limits.paused {
            return Err(BlockReason::Paused);
        }
        if amount == 0 {
            return Err(BlockReason::InvalidInput);
        }
        if self.requests.contains_key(request_id) {
            return Err(BlockReason::DuplicateRequest);
        }
        // R19: count of requests per period, and NEAR left for the storage a request uses
        if self.requests_this_period(envelope_id, spender, period_start) >= MAX_REQUESTS_PER_PERIOD
        {
            return Err(BlockReason::TooManyRequests);
        }
        if free_near() < STORAGE_RESERVE {
            return Err(BlockReason::InsufficientStorageFloat);
        }
        // 2. payee allowed, or approved and still in the delay
        if !envelope.payees.contains(payee) {
            return Err(if self.payee_pending(envelope_id, payee) {
                BlockReason::PayeePending
            } else {
                BlockReason::PayeeNotAllowed
            });
        }
        // 3. same work for the same payee, pending or paid, unless an approver overrode it
        let work = work_key(envelope_id, payee, work_ref);
        if self.work_claims.contains_key(&work)
            && !self
                .work_overrides
                .contains_key(&override_key(&work, spender))
        {
            return Err(BlockReason::DuplicateWork);
        }
        // 4. tier from the amount, and from the payee's record in this budget (tasks)
        let trusted_limit = self.trusted_limit(envelope_id, payee);
        let tier = tier_for(envelope, limits.auto_limit.0, trusted_limit, amount);
        // 5. budget checks for the tiers paid from the budget
        if tier == Tier::Escalate {
            if limits.open_escalations >= MAX_OPEN_ESCALATIONS {
                return Err(BlockReason::TooManyEscalations);
            }
        } else {
            if tier == Tier::OneApprover && envelope.pending.len() >= MAX_PENDING {
                return Err(BlockReason::TooManyPending);
            }
            if amount > envelope.available().saturating_add(held) {
                return Err(BlockReason::OverAvailable);
            }
            let period_ok =
                |spent: u128, cap: u128| spent.checked_add(amount).is_some_and(|t| t <= cap);
            if !period_ok(period_spent, envelope.period_cap)
                || !period_ok(limits.period_spent.0, limits.period_cap.0)
            {
                return Err(BlockReason::OverPeriodCap);
            }
        }
        Ok(tier)
    }

    pub(crate) fn pay(
        &self,
        token_id: &AccountId,
        request_id: &str,
        payee: &AccountId,
        amount: U128,
        memo: String,
    ) -> Promise {
        ext_ft_core::ext(token_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(payee.clone(), amount, Some(memo))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_PAID)
                    .on_paid(request_id.to_owned()),
            )
    }

    /// R22: pays the DAO's money held for `request` to its payee. The request is `paying`
    /// until `on_dao_payout`, so a second call can't send it twice.
    pub(crate) fn pay_from_dao(
        &mut self,
        token_id: &AccountId,
        request_id: &str,
        mut request: Request,
    ) -> Promise {
        let payee = request.payee.clone();
        let amount = request.amount;
        request.status = RequestStatus::Paying;
        self.requests.insert(request_id.to_owned(), request);
        ext_ft_core::ext(token_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(payee, amount, Some(format!("earmark {request_id}")))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_DAO_PAYOUT)
                    .on_dao_payout(request_id.to_owned()),
            )
    }

    /// Whether this call can still schedule `pay_from_dao` and finish. A DAO vote from Trezu
    /// leaves `ft_on_transfer` about 28 Tgas (measured on mainnet, 9 Nov).
    pub(crate) fn gas_left_for_dao_payout(&self) -> bool {
        let left = env::prepaid_gas().saturating_sub(env::used_gas());
        left >= GAS_FT_TRANSFER
            .saturating_add(GAS_ON_DAO_PAYOUT)
            .saturating_add(GAS_DAO_PAYOUT_MARGIN)
    }

    fn envelope_token(&self, request: &Request) -> AccountId {
        self.envelopes
            .get(&request.envelope_id.0)
            .unwrap()
            .token_id
            .clone()
    }

    fn can_pay_bond(&self, bond: NearToken) -> bool {
        free_near() >= bond.saturating_add(STORAGE_RESERVE)
    }

    /// Requests `spender` made in `envelope_id` during the period starting at `period_start`.
    pub(crate) fn requests_this_period(
        &self,
        envelope_id: EnvelopeId,
        spender: &AccountId,
        period_start: u64,
    ) -> u32 {
        self.request_counts
            .get(&spender_key(envelope_id, spender))
            .filter(|c| c.period_start_ns == period_start)
            .map_or(0, |c| c.count)
    }

    /// A confirmed payment: counts for the spender's record (R9) and the payee's record (R21).
    fn count_payment(&mut self, request: &Request) {
        let now = U64(env::block_timestamp());
        let amount = request.amount.0;
        let mut record = self
            .records
            .get(&request.spender)
            .cloned()
            .unwrap_or_default();
        record.paid_count += 1;
        record.paid_total = U128(record.paid_total.0.saturating_add(amount));
        record.first_paid_at_ns.get_or_insert(now);
        self.records.insert(request.spender.clone(), record);

        let mut payee = self
            .payee_records
            .get(&request.payee)
            .cloned()
            .unwrap_or_default();
        payee.paid_count += 1;
        payee.paid_total = U128(payee.paid_total.0.saturating_add(amount));
        payee.first_paid_at_ns.get_or_insert(now);
        payee.last_paid_at_ns = Some(now);
        self.payee_records.insert(request.payee.clone(), payee);
    }

    fn free_escalation_slot(&mut self, request: &Request) {
        let envelope = self.envelopes.get_mut(&request.envelope_id.0).unwrap();
        if let Some(limits) = envelope.spenders.get_mut(&request.spender) {
            limits.open_escalations = limits.open_escalations.saturating_sub(1);
        }
    }

    pub(crate) fn settle_paid(&mut self, request_id: &str, mut request: Request) {
        request.status = RequestStatus::Paid;
        self.count_payment(&request);
        Event::SpendPaid {
            request_id,
            payee: &request.payee,
            amount: request.amount,
        }
        .emit();
        self.task_settled(request_id, &request, true);
        self.requests.insert(request_id.to_owned(), request);
    }

    /// Marks the request failed and frees what it held.
    pub(crate) fn settle_failed(&mut self, request_id: &str, request: Request, reason: &str) {
        log!("spend {} failed: {}", request_id, reason);
        Event::SpendFailed { request_id, reason }.emit();
        self.release(request_id, request, RequestStatus::Failed, Some(reason));
    }

    /// Frees period usage, work claim and escalation slot, and stores the final status. The
    /// caller has already removed the amount from `committed` or `in_flight`.
    pub(crate) fn release(
        &mut self,
        request_id: &str,
        mut request: Request,
        status: RequestStatus,
        reason: Option<&str>,
    ) {
        let id = request.envelope_id.0;
        let envelope = self.envelopes.get_mut(&id).unwrap();
        if let Some(mut limits) = envelope.spenders.get(&request.spender).cloned() {
            if request.tier == Tier::Escalate {
                limits.open_escalations = limits.open_escalations.saturating_sub(1);
            } else if request.period_start_ns.0 == limits.period_start_ns.0 {
                limits.period_spent = U128(limits.period_spent.0.saturating_sub(request.amount.0));
            }
            envelope.spenders.insert(request.spender.clone(), limits);
        }
        if request.tier != Tier::Escalate && request.period_start_ns.0 == envelope.period_start_ns {
            envelope.period_spent = envelope.period_spent.saturating_sub(request.amount.0);
        }
        envelope.pending.remove(request_id);
        // After an override the claim belongs to the earlier request for the same work.
        let work = work_key(id, &request.payee, &request.work_ref);
        if self.work_claims.get(&work).is_some_and(|r| r == request_id) {
            self.work_claims.remove(&work);
        }
        request.status = status;
        request.failure = reason.map(str::to_owned);
        self.task_settled(request_id, &request, false);
        self.requests.insert(request_id.to_owned(), request);
    }
}

/// The contract's NEAR not locked for storage.
pub(crate) fn free_near() -> NearToken {
    let storage = env::storage_byte_cost().saturating_mul(u128::from(env::storage_usage()));
    env::account_balance().saturating_sub(storage)
}

/// R22: what an `Approved` proposal means for a request that is still `escalated`.
/// - Sent to Earmark (filed after R22): the money would have made the request `dao_funded`.
///   `SETTLE_WAIT_BLOCKS` after the vote it never came (Earmark refused it or it was refunded),
///   so the payee wasn't paid: `dao_payment_returned`.
/// - Sent to the payee directly (filed before R22): Sputnik turns the proposal `Failed` if its
///   transfer fails, so still `Approved` that long after the vote means it paid.
///
/// `None` = wait. A proposal without Sputnik's action log (older DAO code) can't be timed: an
/// R22 one waits, an older one is trusted as before.
fn approved_outcome(proposal: &serde_json::Value) -> Option<&'static str> {
    let to_earmark = proposal
        .pointer("/kind/Transfer/receiver_id")
        .and_then(|r| r.as_str())
        == Some(env::current_account_id().as_str());
    let last_vote = proposal
        .get("last_actions_log")
        .and_then(|log| log.as_array()?.last()?.get("block_height").cloned())
        .and_then(|b| {
            b.as_str()
                .and_then(|s| s.parse::<u64>().ok())
                .or(b.as_u64())
        });
    let waited = last_vote.map(|b| env::block_height() >= b.saturating_add(SETTLE_WAIT_BLOCKS));
    match (to_earmark, waited) {
        (true, Some(true)) => Some("dao_payment_returned"),
        (true, _) => None,
        (false, Some(false)) => None,
        (false, _) => Some("approved"),
    }
}

/// Sputnik's expiry rule: `submission_time + proposal_period < now`. Unreadable values count
/// as not expired, so the request just stays `escalated`.
fn past_vote_period(proposal: &serde_json::Value, policy: Option<&serde_json::Value>) -> bool {
    let nanos = |v: Option<&serde_json::Value>| {
        v.and_then(|v| {
            v.as_str()
                .and_then(|s| s.parse::<u64>().ok())
                .or(v.as_u64())
        })
    };
    let submitted = nanos(proposal.get("submission_time"));
    let period = nanos(policy.and_then(|p| p.get("proposal_period")));
    match (submitted, period) {
        (Some(s), Some(p)) => s.saturating_add(p) < env::block_timestamp(),
        _ => false,
    }
}
