use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, near};

use crate::{Change, Tier};

/// NEP-297 events, standard `earmark`.
#[near(event_json(standard = "earmark"))]
pub enum Event<'a> {
    #[event_version("1.0.0")]
    EnvelopeCreated {
        envelope_id: U64,
        name: &'a str,
        token_id: &'a AccountId,
    },
    #[event_version("1.0.0")]
    EnvelopeFunded {
        envelope_id: U64,
        token_id: &'a AccountId,
        amount: U128,
        balance: U128,
    },
    #[event_version("1.0.0")]
    SpendRequested {
        request_id: &'a str,
        envelope_id: U64,
        spender: &'a AccountId,
        payee: &'a AccountId,
        amount: U128,
        tier: Tier,
    },
    #[event_version("1.0.0")]
    SpendPaid {
        request_id: &'a str,
        payee: &'a AccountId,
        amount: U128,
    },
    #[event_version("1.0.0")]
    SpendFailed {
        request_id: &'a str,
        reason: &'a str,
    },
    #[event_version("1.0.0")]
    SpendEscalated {
        request_id: &'a str,
        dao_proposal_id: Option<U64>,
    },
    /// R18. `outcome`: `approved`, `rejected`, `removed`, `expired` or `moved`.
    #[event_version("1.0.0")]
    EscalationSettled {
        request_id: &'a str,
        dao_proposal_id: Option<U64>,
        outcome: &'a str,
    },
    /// R22: paying the DAO's money to the payee failed (for example the payee isn't registered
    /// with the token). The money stays held for the request; `settle_escalation` retries.
    #[event_version("1.0.0")]
    DaoPayoutFailed { request_id: &'a str },
    /// R22: the DAO took back the money held for a request (`return_escalation`).
    #[event_version("1.0.0")]
    DaoFundsReturned { request_id: &'a str, amount: U128 },
    #[event_version("1.0.0")]
    SpendApproved {
        request_id: &'a str,
        approver: &'a AccountId,
    },
    #[event_version("1.0.0")]
    SpendRejected {
        request_id: &'a str,
        approver: &'a AccountId,
        reason: &'a str,
        for_cause: bool,
    },
    #[event_version("1.0.0")]
    SpendExpired { request_id: &'a str },
    #[event_version("1.0.0")]
    DuplicateOverridden {
        envelope_id: U64,
        spender: &'a AccountId,
        payee: &'a AccountId,
        work_ref: &'a str,
        approver: &'a AccountId,
        reason: &'a str,
    },
    #[event_version("1.0.0")]
    ChangeQueued {
        change_id: U64,
        envelope_id: U64,
        change: &'a Change,
        queued_by: &'a AccountId,
        effective_at_ns: U64,
    },
    /// `change_id` is `None` for a tightening change, which applies without being queued.
    #[event_version("1.0.0")]
    ChangeApplied {
        change_id: Option<U64>,
        envelope_id: U64,
        change: &'a Change,
    },
    #[event_version("1.0.0")]
    ChangeCancelled { change_id: U64, by: &'a AccountId },
    #[event_version("1.0.0")]
    ChangeStale { change_id: U64 },
    #[event_version("1.0.0")]
    EnvelopeClosed {
        envelope_id: U64,
        rejected_requests: u32,
        refund: U128,
    },
    #[event_version("1.0.0")]
    CloseRefundFailed { envelope_id: U64, amount: U128 },
}
