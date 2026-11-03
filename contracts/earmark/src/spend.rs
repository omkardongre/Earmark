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
    BlockReason, MAX_OPEN_ESCALATIONS, Record, Request, RequestStatus, SpendCheck, Tier,
    override_key, tier_for, valid_text, work_key,
};
use crate::{Contract, ContractExt, EnvelopeId};

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_ON_PAID: Gas = Gas::from_tgas(10);
const GAS_GET_POLICY: Gas = Gas::from_tgas(10);
const GAS_ADD_PROPOSAL: Gas = Gas::from_tgas(20);
const GAS_ON_ESCALATED: Gas = Gas::from_tgas(10);
const GAS_ON_POLICY: Gas = Gas::from_tgas(45);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// NEAR kept back from the bond float for the contract's own storage growth.
const STORAGE_RESERVE: NearToken = NearToken::from_millinear(500);

#[ext_contract(ext_dao)]
#[allow(dead_code)]
trait SputnikDao {
    fn get_policy(&self) -> serde_json::Value;
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
        match self.evaluate(
            envelope_id.0,
            &spender,
            &request_id,
            &payee,
            amount.0,
            &work_ref,
        ) {
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

        let envelope = self.envelopes.get_mut(&id).unwrap();
        let period_start_ns = envelope.period_start_ns;
        let mut limits = envelope.spender_current(&spender).unwrap();
        let status = match tier {
            Tier::Auto => {
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
        self.requests.insert(request_id.clone(), request);
        match tier {
            Tier::Auto => self
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

    pub fn get_request(&self, request_id: String) -> Option<Request> {
        self.requests.get(&request_id).cloned()
    }

    /// The spender's record across budgets (R9 reads it).
    pub fn get_record(&self, account_id: AccountId) -> Record {
        self.records.get(&account_id).cloned().unwrap_or_default()
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
        let description = format!(
            "Earmark request {request_id} (budget {}): {} to {}. Work: {}. {}",
            request.envelope_id.0, request.amount.0, request.payee, request.work_ref, request.memo
        );
        let proposal = json!({
            "description": description,
            "kind": { "Transfer": {
                "token_id": token_id,
                "receiver_id": request.payee,
                "amount": request.amount,
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
        let envelope = self
            .envelopes
            .get(&envelope_id)
            .ok_or(BlockReason::Closed)?;
        // 1. closed / paused / not_spender / duplicate_request
        if envelope.closed {
            return Err(BlockReason::Closed);
        }
        let limits = envelope
            .spender_current(spender)
            .ok_or(BlockReason::NotSpender)?;
        if envelope.paused || limits.paused {
            return Err(BlockReason::Paused);
        }
        if amount == 0 {
            return Err(BlockReason::InvalidInput);
        }
        if self.requests.contains_key(request_id) {
            return Err(BlockReason::DuplicateRequest);
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
        // 4. tier from the amount only
        let tier = tier_for(envelope, limits.auto_limit.0, amount);
        // 5. budget checks for the tiers paid from the budget
        if tier == Tier::Escalate {
            if limits.open_escalations >= MAX_OPEN_ESCALATIONS {
                return Err(BlockReason::TooManyEscalations);
            }
        } else {
            if tier == Tier::OneApprover && envelope.pending.len() >= MAX_PENDING {
                return Err(BlockReason::TooManyPending);
            }
            if amount > envelope.available() {
                return Err(BlockReason::OverAvailable);
            }
            let period_ok =
                |spent: u128, cap: u128| spent.checked_add(amount).is_some_and(|t| t <= cap);
            if !period_ok(envelope.period_spent, envelope.period_cap)
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

    fn can_pay_bond(&self, bond: NearToken) -> bool {
        let storage = env::storage_byte_cost().saturating_mul(u128::from(env::storage_usage()));
        let free = env::account_balance().saturating_sub(storage);
        free >= bond.saturating_add(STORAGE_RESERVE)
    }

    pub(crate) fn settle_paid(&mut self, request_id: &str, mut request: Request) {
        request.status = RequestStatus::Paid;
        let now = env::block_timestamp();
        let mut record = self
            .records
            .get(&request.spender)
            .cloned()
            .unwrap_or_default();
        record.paid_count += 1;
        record.paid_total = U128(record.paid_total.0 + request.amount.0);
        record.first_paid_at_ns.get_or_insert(U64(now));
        self.records.insert(request.spender.clone(), record);
        Event::SpendPaid {
            request_id,
            payee: &request.payee,
            amount: request.amount,
        }
        .emit();
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
        self.requests.insert(request_id.to_owned(), request);
    }
}
