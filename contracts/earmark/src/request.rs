//! Spend requests, their tiers and the checks shared by `check_spend` and `request_spend`.

use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, CryptoHash, env, near};

use crate::{Envelope, EnvelopeId};

pub const MAX_ID_BYTES: usize = 64;
pub const MAX_TEXT_BYTES: usize = 256;
/// Open escalations per spender, so a leaked key can't drain the bond and storage float.
pub const MAX_OPEN_ESCALATIONS: u32 = 5;
/// Requests per spender per budget period (R19). Period caps limit the amount, not the count;
/// this stops a leaked key from locking the storage NEAR with many tiny requests.
pub const MAX_REQUESTS_PER_PERIOD: u32 = 100;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Tier {
    /// Paid at once from the budget.
    Auto,
    /// Reserved; waits for one approver.
    OneApprover,
    /// Becomes a DAO Transfer proposal that sends the amount from the treasury to Earmark,
    /// which pays the payee and records it; nothing is reserved from the budget.
    Escalate,
    /// Paid at once because the payee is a trusted contributor of this budget: above the
    /// spender's own limit, but within the budget's trusted limit (tasks). Added after R23.
    Trusted,
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
    TooManyRequests,
    /// The contract's free NEAR is below the reserve kept for storage.
    InsufficientStorageFloat,
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
            Self::TooManyRequests => "too_many_requests",
            Self::InsufficientStorageFloat => "insufficient_storage_float",
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RequestStatus {
    /// Transfer to the payee sent, waiting for its result (auto tier, or DAO money being paid).
    Paying,
    PendingApproval,
    /// DAO proposal being filed.
    Escalating,
    /// DAO proposal filed; the DAO vote decides.
    Escalated,
    Paid,
    Failed,
    Rejected,
    Expired,
    /// R18: the payee received the DAO's money; Earmark saw its own transfer succeed (or, for
    /// a proposal filed before R22 that paid the payee directly, the vote passed and stayed
    /// passed). The work claim stays.
    PaidByDao,
    /// R18: the DAO proposal was rejected, expired, removed or moved, or its money came back.
    /// `failure` says which.
    EscalationClosed,
    /// R22: the DAO's money arrived at Earmark and is held for this request until it is paid
    /// out. `failure` is set if a payout attempt failed; `settle_escalation` tries again.
    DaoFunded,
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

/// Payee record across budgets (R21): grows only when a payment is confirmed (budget transfer
/// succeeded, or the DAO paid an escalation), never on failure.
#[near(serializers = [borsh, json])]
#[derive(Clone, Default)]
pub struct PayeeRecord {
    pub paid_count: u32,
    pub paid_total: U128,
    pub first_paid_at_ns: Option<U64>,
    pub last_paid_at_ns: Option<U64>,
}

/// Requests a spender made in one budget period (R19).
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Default)]
pub struct RequestCount {
    pub period_start_ns: u64,
    pub count: u32,
}

/// `(envelope, spender)` key for the request count.
pub fn spender_key(envelope_id: EnvelopeId, spender: &AccountId) -> CryptoHash {
    let mut data = b"rc".to_vec();
    data.extend_from_slice(&envelope_id.to_le_bytes());
    data.extend_from_slice(spender.as_bytes());
    env::sha256_array(&data)
}

/// Trezu's description format, so the escalation shows as a readable Payment Request there and
/// in its alerts. The proposal's recipient is Earmark, so the title names the real payee.
/// `<br>` and line breaks are removed from user text so it can't add fields.
pub fn escalation_description(
    request_id: &str,
    envelope_id: EnvelopeId,
    spender: &AccountId,
    payee: &AccountId,
    memo: &str,
    work_ref: &str,
) -> String {
    let clean = |s: &str| {
        s.replace("<br>", " ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    };
    let memo = clean(memo);
    let request_id = clean(request_id);
    let notes = if memo.is_empty() {
        format!("by {spender} · budget {envelope_id} · request {request_id}")
    } else {
        format!("{memo} · by {spender} · budget {envelope_id} · request {request_id}")
    };
    format!(
        "* Title: Pay {payee} through Earmark <br>* Notes: {notes} <br>* Url: {}",
        clean(work_ref)
    )
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

/// The tier from the amount only (R17 step 4). `trusted_limit` is 0 unless the payee is a
/// trusted contributor of this budget; it never reaches past the one-approver limit.
pub fn tier_for(envelope: &Envelope, auto_limit: u128, trusted_limit: u128, amount: u128) -> Tier {
    let trusted_limit = trusted_limit.min(envelope.one_approver_limit);
    if amount <= auto_limit {
        Tier::Auto
    } else if amount <= trusted_limit {
        Tier::Trusted
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
