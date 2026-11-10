import type { BlockReason, RequestStatus, TokenMeta } from "./types";

/** Token base units -> "12.5". Amounts are always shown in token units, never converted (R15). */
export function units(amount: string | bigint, meta: TokenMeta): string {
  const v = BigInt(amount);
  const base = 10n ** BigInt(meta.decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(meta.decimals, "0").replace(/0+$/, "").slice(0, 2);
  return `${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
}

export const money = (amount: string | bigint, meta: TokenMeta) =>
  `${units(amount, meta)} ${meta.symbol}`;

/** "12.5" -> base units, or null if it isn't a positive amount with at most `decimals` places. */
export function toBase(input: string, meta: TokenMeta): string | null {
  const s = input.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole = "0", frac = ""] = s.split(".");
  if (frac.length > meta.decimals) return null;
  const v =
    BigInt(whole) * 10n ** BigInt(meta.decimals) + BigInt(frac.padEnd(meta.decimals, "0") || "0");
  return v > 0n ? v.toString() : null;
}

/**
 * "sofia-reyes.earmark.testnet" -> "Sofia Reyes": the name people read. The full account is kept
 * in titles, links and wherever the exact account matters (the pay sheet, the wallet).
 */
export function shortName(account: string): string {
  if (account.length === 64) return `${account.slice(0, 6)}…${account.slice(-4)}`;
  const first = account.split(".")[0] ?? account;
  return first
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function ago(ns: string | bigint): string {
  const secs = Math.max(0, (Date.now() - Number(BigInt(ns) / 1_000_000n)) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} h ago`;
  return `${Math.floor(secs / 86400)} d ago`;
}

export function duration(secs: number): string {
  if (secs >= 86400 && secs % 86400 === 0) return `${secs / 86400} day${secs === 86400 ? "" : "s"}`;
  if (secs >= 3600 && secs % 3600 === 0) return `${secs / 3600} h`;
  if (secs >= 60) return `${Math.round(secs / 60)} min`;
  return `${secs} s`;
}

export const STATUS: Record<
  RequestStatus,
  { label: string; tone: "green" | "amber" | "blue" | "gray" | "red" }
> = {
  paying: { label: "Paying", tone: "blue" },
  pending_approval: { label: "Needs approval", tone: "amber" },
  escalating: { label: "Sending to DAO", tone: "blue" },
  escalated: { label: "DAO vote", tone: "blue" },
  paid: { label: "Paid", tone: "green" },
  failed: { label: "Failed", tone: "red" },
  rejected: { label: "Rejected", tone: "red" },
  expired: { label: "Expired", tone: "gray" },
  paid_by_dao: { label: "Paid by DAO", tone: "green" },
  escalation_closed: { label: "DAO vote closed", tone: "gray" },
  dao_funded: { label: "DAO approved", tone: "blue" },
};

/** Plain-words reason for a blocked payment, with what to do about it. */
export const BLOCKED: Record<BlockReason, string> = {
  closed: "This budget is closed.",
  paused: "Payments are paused. An approver can unpause.",
  not_spender: "You can't pay from this budget.",
  duplicate_request: "This payment was already sent.",
  payee_not_allowed: "Payee not approved. Ask an approver to add them.",
  payee_pending: "Payee was just approved and becomes payable after the waiting period.",
  duplicate_work: "This work was already paid to this person.",
  over_available: "Not enough left in the budget.",
  over_period_cap: "Over the limit for this period.",
  too_many_escalations: "You have too many requests waiting for a DAO vote.",
  too_many_pending: "Too many payments are waiting for approval.",
  invalid_input: "Check the amount and the work link.",
  too_many_requests: "You made the most payments allowed this period.",
  insufficient_storage_float:
    "Payments are paused for now: the contract is low on NEAR. Your council can top it up.",
};

/** Contract panic text -> a plain message. */
export function errorMessage(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  // Wallets refuse to send when the account can't cover prepaid gas at the worst-case price.
  const fee = text.match(
    /Sender (\S+) does not have enough balance [\d.]+ for operation costing ([\d.]+)/,
  );
  if (fee)
    return `${fee[1]} needs about ${Number(fee[2]).toFixed(2)} NEAR to cover network fees (most is refunded). Add NEAR to it and try again.`;
  const code =
    text.match(/Smart contract panicked: ([a-z_]+)/)?.[1] ??
    text.match(/\b([a-z]+(?:_[a-z]+)+)\b/)?.[1];
  if (code && code in BLOCKED) return BLOCKED[code as BlockReason];
  const known: Record<string, string> = {
    not_yet: "The waiting period isn't over yet.",
    not_eligible: "This spender isn't eligible for a raise yet.",
    above_ceiling: "That's above the limit the DAO allows.",
    not_approver: "Only an approver can do this.",
    self_approval: "You can't approve your own payment.",
    self_raise: "You can't raise your own limit.",
    already_queued: "This change is already waiting.",
    too_many_queued: "Too many changes are waiting on this budget.",
    not_queued: "This change is no longer waiting.",
    expired: "This request expired.",
    no_other_approver: "Each spender needs an approver other than themselves.",
    not_escalated: "This payment isn't waiting for a DAO vote.",
  };
  if (code && known[code]) return known[code];
  if (/reject|cancel|denied|closed by user/i.test(text)) return "Cancelled in your wallet.";
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}
