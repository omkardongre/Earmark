//! One-approver tier: `approve`, `reject` and `expire` for requests waiting in `pending_approval`.

use near_sdk::json_types::U64;
use near_sdk::{AccountId, Promise, env, near, require};

use crate::events::Event;
use crate::request::{BlockReason, MAX_TEXT_BYTES, Request, RequestStatus};
use crate::{Contract, ContractExt};

const NANOS_PER_SEC: u64 = 1_000_000_000;

#[near]
impl Contract {
    /// Any approver except the spender (R2). Runs the request checks again, so a payee removed
    /// or a spender paused after the request was made can't be paid.
    pub fn approve(&mut self, request_id: String) -> Promise {
        let approver = env::predecessor_account_id();
        let mut request = self.pending(&request_id, &approver);
        require!(!self.is_expired(&request), "expired");
        if let Err(reason) = self.recheck(&request) {
            env::panic_str(reason.code());
        }

        let envelope = self.envelopes.get_mut(&request.envelope_id.0).unwrap();
        envelope.committed -= request.amount.0;
        envelope.in_flight += request.amount.0;
        let token_id = envelope.token_id.clone();
        request.status = RequestStatus::Paying;
        request.decided_by = Some(approver.clone());
        let (payee, amount) = (request.payee.clone(), request.amount);
        self.requests.insert(request_id.clone(), request);

        Event::SpendApproved {
            request_id: &request_id,
            approver: &approver,
        }
        .emit();
        let memo = format!("earmark {request_id}");
        self.pay(&token_id, &request_id, &payee, amount, memo)
    }

    /// Any approver except the spender. `for_cause` counts against the spender's record (R9).
    pub fn reject(&mut self, request_id: String, reason: String, for_cause: bool) {
        let approver = env::predecessor_account_id();
        require!(
            !reason.trim().is_empty() && reason.len() <= MAX_TEXT_BYTES,
            "invalid_reason"
        );
        let mut request = self.pending(&request_id, &approver);
        self.envelopes
            .get_mut(&request.envelope_id.0)
            .unwrap()
            .committed -= request.amount.0;

        if for_cause {
            let mut record = self
                .records
                .get(&request.spender)
                .cloned()
                .unwrap_or_default();
            record.rejected_for_cause += 1;
            record.last_reject_at_ns = Some(U64(env::block_timestamp()));
            self.records.insert(request.spender.clone(), record);
        }
        Event::SpendRejected {
            request_id: &request_id,
            approver: &approver,
            reason: &reason,
            for_cause,
        }
        .emit();
        request.decided_by = Some(approver);
        self.release(&request_id, request, RequestStatus::Rejected, Some(&reason));
    }

    /// Anyone, once the request has waited longer than the budget's `pending_ttl_secs` (R7).
    pub fn expire(&mut self, request_id: String) {
        let request = self
            .requests
            .get(&request_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown_request"));
        require!(
            request.status == RequestStatus::PendingApproval,
            "not_pending"
        );
        require!(self.is_expired(&request), "not_expired");
        self.envelopes
            .get_mut(&request.envelope_id.0)
            .unwrap()
            .committed -= request.amount.0;
        Event::SpendExpired {
            request_id: &request_id,
        }
        .emit();
        self.release(&request_id, request, RequestStatus::Expired, None);
    }
}

impl Contract {
    /// A pending request that `approver` may decide.
    fn pending(&self, request_id: &str, approver: &AccountId) -> Request {
        let request = self
            .requests
            .get(request_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown_request"));
        require!(
            request.status == RequestStatus::PendingApproval,
            "not_pending"
        );
        let envelope = self.envelopes.get(&request.envelope_id.0).unwrap();
        require!(envelope.approvers.contains(approver), "not_approver");
        require!(request.spender != *approver, "self_approval");
        request
    }

    fn is_expired(&self, request: &Request) -> bool {
        let envelope = self.envelopes.get(&request.envelope_id.0).unwrap();
        let ttl_ns = envelope.pending_ttl_secs * NANOS_PER_SEC;
        env::block_timestamp() >= request.created_at_ns.0.saturating_add(ttl_ns)
    }

    /// Check order steps 1–2 at decision time: budget open and not paused, spender still a
    /// spender and not paused, payee still allowed.
    fn recheck(&self, request: &Request) -> Result<(), BlockReason> {
        let envelope = self.envelopes.get(&request.envelope_id.0).unwrap();
        if envelope.closed {
            return Err(BlockReason::Closed);
        }
        let limits = envelope
            .spenders
            .get(&request.spender)
            .ok_or(BlockReason::NotSpender)?;
        if envelope.paused || limits.paused {
            return Err(BlockReason::Paused);
        }
        if !envelope.payees.contains(&request.payee) {
            return Err(BlockReason::PayeeNotAllowed);
        }
        Ok(())
    }
}
