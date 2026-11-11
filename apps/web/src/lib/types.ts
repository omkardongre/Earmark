// Shapes returned by the Earmark contract views (amounts are token base units as strings).
/** `trusted`: paid at once because the payee is a trusted contributor of the budget (tasks). */
export type Tier = "auto" | "one_approver" | "escalate" | "trusted";

export type BlockReason =
  | "closed"
  | "paused"
  | "not_spender"
  | "duplicate_request"
  | "payee_not_allowed"
  | "payee_pending"
  | "duplicate_work"
  | "over_available"
  | "over_period_cap"
  | "too_many_escalations"
  | "too_many_pending"
  | "invalid_input"
  | "too_many_requests"
  | "insufficient_storage_float";

export type RequestStatus =
  | "paying"
  | "pending_approval"
  | "escalating"
  | "escalated"
  | "paid"
  | "failed"
  | "rejected"
  | "expired"
  | "paid_by_dao"
  | "escalation_closed"
  | "dao_funded";

export type SpenderLimits = {
  auto_limit: string;
  period_cap: string;
  period_spent: string;
  period_start_ns: string;
  open_escalations: number;
  paused: boolean;
};

export type Budget = {
  id: string;
  name: string;
  token_id: string;
  balance: string;
  available: string;
  committed: string;
  in_flight: string;
  spent_total: string;
  period_secs: string;
  period_cap: string;
  period_spent: string;
  period_start_ns: string;
  spenders: [string, SpenderLimits][];
  approvers: string[];
  one_approver_limit: string;
  raise_ceiling: string;
  payees: string[];
  pending_ttl_secs: string;
  paused: boolean;
  closed: boolean;
  pending_requests: string[];
  open_changes: number;
  request_count: string;
};

export type SpendRequest = {
  envelope_id: string;
  spender: string;
  payee: string;
  amount: string;
  memo: string;
  work_ref: string;
  receipt: string | null;
  tier: Tier;
  status: RequestStatus;
  period_start_ns: string;
  created_at_ns: string;
  decided_by: string | null;
  dao_proposal_id: string | null;
  failure: string | null;
};

export type Config = {
  dao_id: string;
  token_ids: string[];
  loosen_delay_secs: string;
  eligibility: { min_paid_count: number; min_history_secs: string; cause_cooldown_secs: string };
  envelope_count: string;
  /** Where near.com payees are paid; missing or null when this contract can't pay them. */
  intents_contract?: string | null;
};

export type SpenderRecord = {
  paid_count: number;
  paid_total: string;
  rejected_for_cause: number;
  first_paid_at_ns: string | null;
  last_reject_at_ns: string | null;
};

/** R21: what a payee has been paid across budgets. */
export type PayeeRecord = {
  paid_count: number;
  paid_total: string;
  first_paid_at_ns: string | null;
  last_paid_at_ns: string | null;
};

export type QueuedChange = {
  envelope_id: string;
  change: Record<string, Record<string, string | null>>;
  queued_by: string;
  by_dao: boolean;
  queued_at_ns: string;
  effective_at_ns: string;
  status: "queued" | "applied" | "cancelled" | "stale";
};

export type TokenMeta = { symbol: string; decimals: number };

export type TaskStatus = "open" | "claimed" | "submitted" | "accepted" | "paid" | "cancelled";

/** A funded task (bounty): its amount is reserved in the budget from posting. */
export type Task = {
  envelope_id: string;
  lead: string;
  title: string;
  brief: string;
  amount: string;
  assignee: string | null;
  claim_days: number;
  status: TaskStatus;
  claimant: string | null;
  claim_ends_ns: string | null;
  work_ref: string | null;
  note: string | null;
  request_id: string | null;
  attempts: number;
  created_at_ns: string;
  reason: string | null;
};

export type TaskRules = {
  trusted_limit: string;
  min_tasks: number;
  min_days: number;
  strike_days: number;
  min_task_amount: string;
};

/** A contributor's task record in one budget, and whether it makes them trusted there. */
export type TrustView = {
  record: {
    tasks_paid: number;
    tasks_paid_total: string;
    first_paid_at_ns: string | null;
    last_strike_at_ns: string | null;
  };
  trusted: boolean;
  trusted_limit: string;
};
