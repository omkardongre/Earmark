// Turns contract events into plain rows for the activity feed: who did what, the amount, a status.
import { money, shortName } from "./format";
import type { EarmarkEvent } from "./near";
import type { SpendRequest, Task, TokenMeta } from "./types";

type ChipTone = "green" | "amber" | "blue" | "gray" | "red";

export type Activity = {
  key: string;
  /** Plain sentence: "alice paid writer-1". */
  text: string;
  amount: string | null;
  chip: { label: string; tone: ChipTone } | null;
  /** Payment rows open the payment page; task rows open the task; others open their transaction. */
  requestId: string | null;
  /** In-app page for a task row ("/budgets/0/tasks/4"). */
  href: string | null;
  tx: string;
  timestampNs: string;
  budget: string | undefined;
  /** Accounts named in the row, for the person page. */
  people: string[];
  /** Rule changes (queued, applied, cancelled) are left out of the home feed. */
  isChange: boolean;
};

/** Which event of a payment its single row shows: the latest step wins. */
const STEP: Record<string, number> = { spend_requested: 1, spend_approved: 2 };
const step = (event: string) => STEP[event] ?? 3;

type Change = Record<string, Record<string, string | null> | undefined>;

export function describeChange(change: Change, meta: TokenMeta): string {
  const [kind, v = {}] = Object.entries(change)[0] ?? ["", {}];
  const who = (k: string) => shortName(String(v?.[k] ?? ""));
  const amt = () => money(String(v?.amount ?? "0"), meta);
  switch (kind) {
    case "spender_auto_limit":
      return `${who("spender")} pays instantly up to ${amt()}`;
    case "spender_period_cap":
      return `${who("spender")} can spend up to ${amt()} per period`;
    case "period_cap":
      return `Budget can spend up to ${amt()} per period`;
    case "one_approver_limit":
      return `One approval covers up to ${amt()}`;
    case "raise_ceiling":
      return `Approvers can raise limits up to ${amt()}`;
    case "add_spender":
      return `Add ${who("spender")} as a spender`;
    case "remove_spender":
      return `Remove spender ${who("spender")}`;
    case "add_approver":
      return `Add ${who("approver")} as an approver`;
    case "remove_approver":
      return `Remove approver ${who("approver")}`;
    case "add_payee":
      return `Allow payments to ${who("payee")}`;
    case "add_intents_payee":
      return `Allow payments to ${who("payee")} on near.com`;
    case "remove_payee":
      return `Stop payments to ${who("payee")}`;
    case "pause":
      return v?.spender ? `Pause ${who("spender")}` : "Pause the budget";
    case "unpause":
      return v?.spender ? `Unpause ${who("spender")}` : "Unpause the budget";
    default:
      return kind.replaceAll("_", " ");
  }
}

/** A change that applied at once, said as what the signer did: "council-2 paused bob". */
function instantChange(change: Change, signer: string, meta: TokenMeta): string {
  const [kind, v = {}] = Object.entries(change)[0] ?? ["", {}];
  const who = (k: string) => shortName(String(v?.[k] ?? ""));
  const by = shortName(signer);
  switch (kind) {
    case "pause":
      return v?.spender ? `${by} paused ${who("spender")}` : `${by} paused the budget`;
    case "remove_payee":
      return `${by} removed payee ${who("payee")}`;
    case "spender_auto_limit":
      return `${by} lowered ${who("spender")}’s limit to ${money(String(v?.amount ?? "0"), meta)}`;
    default:
      return `${by} changed a rule: ${describeChange(change, meta).toLowerCase()}`;
  }
}

const changeAccounts = (change: Change) =>
  Object.values(change).flatMap((v) =>
    Object.entries(v ?? {})
      .filter(([k, x]) => k !== "amount" && typeof x === "string")
      .map(([, x]) => x as string),
  );

export function activityFeed(
  events: EarmarkEvent[],
  requests: Map<string, SpendRequest>,
  metaFor: (budget: string) => TokenMeta | undefined,
  {
    tasks = new Map(),
    waiting = null,
  }: {
    /** Tasks named by task events: their budget, title and people. */
    tasks?: Map<string, Task>;
    /** Ids of rule changes still in their waiting period; null if unknown. */
    waiting?: Set<string> | null;
  } = {},
): Activity[] {
  const out: Activity[] = [];
  const ranks: number[] = [];
  // Keys must stay the same across fetches (the feed merges a refreshed first page into what's
  // loaded), so they come from the transaction and the event, not the position in the page.
  const seen = new Map<string, number>();
  events.forEach((e) => {
    const base = `${e.tx}-${e.event}`;
    const nth = seen.get(base) ?? 0;
    seen.set(base, nth + 1);
    const d = e.data;
    const str = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : "");
    const name = (k: string) => shortName(str(k));
    const change = d.change as Change;
    const requestId = str("request_id") || null;
    const req = requestId ? requests.get(requestId) : undefined;
    const taskId = str("task_id") || null;
    const task = taskId ? tasks.get(taskId) : undefined;
    const budget =
      typeof d.envelope_id === "string" || typeof d.envelope_id === "number"
        ? String(d.envelope_id)
        : (req?.envelope_id ?? task?.envelope_id);
    const meta = budget === undefined ? undefined : metaFor(budget);
    if (!meta) return;
    const amount = (a?: string) => money(a || req?.amount || "0", meta);
    const payee = req ? shortName(req.payee) : "someone";
    const people = [e.signer, req?.spender, req?.payee, task?.lead, task?.claimant].filter(
      (x): x is string => !!x,
    );
    const title = task ? `“${task.title}”` : "a task";

    let row: Pick<Activity, "text" | "amount" | "chip"> | null = null;
    switch (e.event) {
      case "envelope_created":
        row = { text: `The DAO created “${str("name")}”`, amount: null, chip: null };
        break;
      case "envelope_funded":
        row = {
          text: "The DAO added funds",
          amount: amount(str("amount")),
          chip: { label: "Funded", tone: "green" },
        };
        break;
      case "spend_requested":
        // An instant payment shows once, as "paid".
        if (str("tier") === "auto" || str("tier") === "trusted") break;
        row = {
          text: `${name("spender")} asked to pay ${name("payee")}`,
          amount: amount(str("amount")),
          chip:
            str("tier") === "one_approver"
              ? { label: "Needs approval", tone: "amber" }
              : { label: "DAO vote", tone: "blue" },
        };
        break;
      case "spend_paid":
        row = {
          text:
            req?.tier === "escalate"
              ? `The DAO paid ${name("payee")}`
              : `${req ? shortName(req.spender) : "The budget"} paid ${name("payee")}`,
          amount: amount(str("amount")),
          chip: { label: "Paid", tone: "green" },
        };
        break;
      case "spend_approved":
        row = {
          text: `${name("approver")} approved the payment to ${payee}`,
          amount: amount(),
          chip: { label: "Approved", tone: "green" },
        };
        break;
      case "spend_rejected":
        row = {
          text: `${name("approver")} rejected the payment to ${payee}: ${str("reason")}`,
          amount: amount(),
          chip: { label: "Rejected", tone: "red" },
        };
        break;
      case "spend_failed":
        row = {
          text: `The payment to ${payee} didn’t go through`,
          amount: amount(),
          chip: { label: "Failed", tone: "red" },
        };
        break;
      case "spend_expired":
        row = {
          text: `The payment to ${payee} expired without a decision`,
          amount: amount(),
          chip: { label: "Expired", tone: "gray" },
        };
        break;
      case "escalation_settled":
        row =
          str("outcome") === "approved"
            ? {
                text: `The DAO voted yes to pay ${payee}`,
                amount: amount(),
                chip: { label: "DAO approved", tone: "blue" },
              }
            : {
                text: `The DAO vote on paying ${payee} closed (${str("outcome").replaceAll("_", " ")})`,
                amount: amount(),
                chip: { label: "Not paid", tone: "gray" },
              };
        break;
      case "dao_payout_failed":
        row = {
          text: `Paying ${payee} didn’t go through yet; the DAO’s money is held for a retry`,
          amount: amount(),
          chip: { label: "Retry", tone: "amber" },
        };
        break;
      case "dao_funds_returned":
        row = {
          text: `The money for ${payee} went back to the DAO`,
          amount: amount(str("amount")),
          chip: { label: "Returned", tone: "gray" },
        };
        break;
      case "change_queued":
        people.push(...changeAccounts(change));
        row = {
          text: `${name("queued_by")} proposed: ${describeChange(change, meta)}`,
          amount: null,
          // Once the change applies, its own "Now in effect" row says so: no stale chip here.
          chip:
            waiting?.has(str("change_id")) === true
              ? { label: "Waiting period", tone: "amber" }
              : null,
        };
        break;
      case "change_applied":
        people.push(...changeAccounts(change));
        row =
          d.change_id === null || d.change_id === undefined
            ? {
                text: instantChange(change, e.signer, meta),
                amount: null,
                chip:
                  Object.keys(change)[0] === "pause" ? { label: "Paused", tone: "amber" } : null,
              }
            : { text: `Now in effect: ${describeChange(change, meta)}`, amount: null, chip: null };
        break;
      case "change_cancelled":
        row = {
          text: `${name("by")} cancelled a waiting change`,
          amount: null,
          chip: { label: "Cancelled", tone: "gray" },
        };
        break;
      case "task_posted":
        row = {
          text: `${name("lead")} posted ${title}`,
          amount: amount(str("amount")),
          chip: null,
        };
        break;
      case "task_claimed":
        row = { text: `${name("claimant")} took ${title}`, amount: null, chip: null };
        break;
      case "work_submitted":
        row = {
          text: `${shortName(task?.claimant ?? e.signer)} sent work for ${title}`,
          amount: null,
          chip: null,
        };
        break;
      case "work_rejected":
        row = {
          text:
            d.for_cause === true
              ? `${name("by")} rejected ${name("contributor")}’s work on ${title}`
              : `${name("by")} sent ${title} back to ${name("contributor")} to fix`,
          amount: null,
          chip: null,
        };
        people.push(str("contributor"));
        break;
      case "claim_released":
        row = {
          text:
            str("by") === task?.lead
              ? `${name("by")} opened ${title} to others`
              : `${name("by")} gave up ${title}`,
          amount: null,
          chip: null,
        };
        break;
      case "task_cancelled":
        row = { text: `${name("by")} cancelled ${title}`, amount: null, chip: null };
        break;
      case "envelope_closed":
        row = {
          text: "The DAO closed the budget and took back the rest",
          amount: amount(str("refund")),
          chip: { label: "Closed", tone: "gray" },
        };
        break;
    }
    if (row) {
      out.push({
        ...row,
        // One row per payment: the key is the payment, so the feed's merge of pages keeps one.
        key: req && requestId ? `req-${requestId}` : `${base}-${nth}`,
        requestId: req ? requestId : null,
        href: !req && task && taskId ? `/budgets/${task.envelope_id}/tasks/${taskId}` : null,
        tx: e.tx,
        timestampNs: e.timestampNs,
        budget,
        people,
        isChange: e.event.startsWith("change_"),
      });
      ranks.push(step(e.event));
    }
  });
  // A payment's steps (asked, approved, paid) collapse into one row showing the latest step.
  // Events come newest first, so the first row kept for a payment sits where it happened last.
  const best = new Map<string, number>();
  out.forEach((a, i) => {
    if (!a.requestId) return;
    const j = best.get(a.requestId);
    if (j === undefined || (ranks[i] ?? 0) > (ranks[j] ?? 0)) best.set(a.requestId, i);
  });
  const first = new Map<string, number>();
  out.forEach((a, i) => {
    if (a.requestId && !first.has(a.requestId)) first.set(a.requestId, i);
  });
  return out.flatMap((a, i) => {
    if (!a.requestId) return [a];
    if (first.get(a.requestId) !== i) return [];
    const b = out[best.get(a.requestId) ?? i] ?? a;
    return [{ ...b, timestampNs: a.timestampNs }];
  });
}
