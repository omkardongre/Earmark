//! Spend requests, their tiers and the checks shared by `check_spend` and `request_spend`.

use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, CryptoHash, env, near};

use crate::{Envelope, EnvelopeId};

pub const MAX_ID_BYTES: usize = 64;
pub const MAX_TEXT_BYTES: usize = 256;
/// Open escalations per spender, so a leaked key can't drain the bond and storage float.
pub const MAX_OPEN_ESCALATIONS: u32 = 5;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Tier {
    /// Paid at once from the budget.
    Auto,
    /// Reserved; waits for one approver.
    OneApprover,
    /// Becomes a Transfer proposal paid from the DAO treasury; nothing is reserved.
    Escalate,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BlockReason {
    Closed,
    Paused,
    NotSpender,
    DuplicateRequest,
    PayeeNotAllowed,
    PayeePending,
    DuplicateWork,
    OverAvailable,
    OverPeriodCap,
    TooManyEscalations,
    TooManyPending,
    InvalidInput,
}

impl BlockReason {
    pub fn code(self) -> &'static str {
        match self {
            Self::Closed => "closed",
            Self::Paused => "paused",
            Self::NotSpender => "not_spender",
            Self::DuplicateRequest => "duplicate_request",
            Self::PayeeNotAllowed => "payee_not_allowed",
            Self::PayeePending => "payee_pending",
            Self::DuplicateWork => "duplicate_work",
            Self::OverAvailable => "over_available",
            Self::OverPeriodCap => "over_period_cap",
            Self::TooManyEscalations => "too_many_escalations",
            Self::TooManyPending => "too_many_pending",
            Self::InvalidInput => "invalid_input",
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RequestStatus {
    /// Auto tier: transfer sent, waiting for its result.
    Paying,
    PendingApproval,
    /// DAO proposal being filed.
    Escalating,
    /// DAO proposal filed; the DAO vote decides and pays.
    Escalated,
    Paid,
    Failed,
    Rejected,
    Expired,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Request {
    pub envelope_id: U64,
    pub spender: AccountId,
    pub payee: AccountId,
    pub amount: U128,
    pub memo: String,
    pub work_ref: String,
    pub receipt: Option<String>,
    pub tier: Tier,
    pub status: RequestStatus,
    /// Period the reservation counts against; a later failure frees it there only.
    pub period_start_ns: U64,
    pub created_at_ns: U64,
    pub decided_by: Option<AccountId>,
    pub dao_proposal_id: Option<U64>,
    pub failure: Option<String>,
}

/// Spender record, built from settled requests.
#[near(serializers = [borsh, json])]
#[derive(Clone, Default)]
pub struct Record {
    pub paid_count: u32,
    pub paid_total: U128,
    pub rejected_for_cause: u32,
    pub first_paid_at_ns: Option<U64>,
    pub last_reject_at_ns: Option<U64>,
}

#[near(serializers = [json])]
pub struct SpendCheck {
    pub tier: Option<Tier>,
    pub blocked: Option<BlockReason>,
}

pub fn work_key(envelope_id: EnvelopeId, payee: &AccountId, work_ref: &str) -> CryptoHash {
    let mut data = envelope_id.to_le_bytes().to_vec();
    data.extend_from_slice(payee.as_bytes());
    data.push(0);
    data.extend_from_slice(work_ref.as_bytes());
    env::sha256_array(&data)
}

/// A one-time pass for `spender` to request the same work again (R16).
pub fn override_key(work: &CryptoHash, spender: &AccountId) -> CryptoHash {
    let mut data = work.to_vec();
    data.extend_from_slice(spender.as_bytes());
    env::sha256_array(&data)
}

/// The tier from the amount only (R17 step 4).
pub fn tier_for(envelope: &Envelope, auto_limit: u128, amount: u128) -> Tier {
    if amount <= auto_limit {
        Tier::Auto
    } else if amount <= envelope.one_approver_limit {
        Tier::OneApprover
    } else {
        Tier::Escalate
    }
}

pub fn valid_text(id: &str, work_ref: &str, memo: &str, receipt: Option<&str>) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_BYTES
        && !work_ref.trim().is_empty()
        && work_ref.len() <= MAX_TEXT_BYTES
        && memo.len() <= MAX_TEXT_BYTES
        && receipt.is_none_or(|r| r.len() <= MAX_TEXT_BYTES)
}
