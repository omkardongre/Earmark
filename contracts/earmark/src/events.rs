use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, near};

use crate::Tier;

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
}
