// Server-side loaders shared by the pages.
import { type Activity, activityFeed } from "./activity";
import {
  allContractEvents,
  contractEvents,
  type EarmarkEvent,
  getConfig,
  getRequest,
  getTask,
  getToken,
  listBudgets,
  listQueued,
  listRequests,
} from "./near";
import type { Budget, Config, SpendRequest, Task, TokenMeta } from "./types";

export type Base = {
  config: Config;
  budgets: Budget[];
  meta: Map<string, TokenMeta>;
};

export async function loadBase(): Promise<Base> {
  const [config, budgets] = await Promise.all([getConfig(), listBudgets()]);
  const meta = new Map<string, TokenMeta>();
  await Promise.all(budgets.map(async (b) => meta.set(b.id, await getToken(b.token_id))));
  return { config, budgets, meta };
}

/**
 * What each payee was paid from this budget: account -> base units. Reads every request (up to
 * 1,000, 100 per call). Never throws: on a read problem the "You earned" line just doesn't show.
 */
export async function paidByPayee(b: Budget): Promise<Record<string, string>> {
  const h = await payeeHistory(b);
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, v.total]));
}

/**
 * How many times and how much each payee was paid from this budget only (one token), from up to
 * 1,000 requests. `get_payee_record` mixes budgets and tokens, so the approval card uses this.
 * Never throws: on a read problem it's empty and the card leaves the line out.
 */
export async function payeeHistory(
  b: Budget,
): Promise<Record<string, { count: number; total: string }>> {
  const pages = Math.ceil(Math.min(Number(b.request_count), 1000) / 100);
  try {
    const lists = await Promise.all(
      Array.from({ length: pages }, (_, i) => listRequests(b.id, { from: i * 100, limit: 100 })),
    );
    const out = new Map<string, { count: number; total: bigint }>();
    for (const [, r] of lists.flat()) {
      if (r.status !== "paid" && r.status !== "paid_by_dao") continue;
      const h = out.get(r.payee) ?? { count: 0, total: 0n };
      out.set(r.payee, { count: h.count + 1, total: h.total + BigInt(r.amount) });
    }
    return Object.fromEntries(
      [...out].map(([k, v]) => [k, { count: v.count, total: v.total.toString() }]),
    );
  } catch {
    return {};
  }
}
/** Newest requests of every budget (one page each), keyed by request id. */
export async function loadRequests(budgets: Budget[], limit = 100) {
  const lists = await Promise.all(budgets.map((b) => listRequests(b.id, { limit })));
  return new Map<string, SpendRequest>(lists.flat());
}

export type ActivityPage = {
  items: Activity[];
  /** Cursor for older rows; null when the start of the history is reached. */
  next: string | null;
  /** False when the transactions API couldn't be reached; numbers still come from the contract. */
  loaded: boolean;
};

/** Rows wanted per page of the feed. */
export const FEED_PAGE = 10;

/**
 * One page of the activity feed, newest first. Reads pages of contract history until it has
 * `FEED_PAGE` rows for the filter (or the history ends), so "Show more" really loads older rows.
 */
export async function loadActivity(
  base: Base,
  {
    cursor,
    budget,
    account,
    skipPayments = false,
    skipChanges = false,
  }: {
    cursor?: string | null | undefined;
    budget?: string | undefined;
    account?: string | undefined;
    /** Leave out payment rows, where a payments table already lists them. */
    skipPayments?: boolean;
    /** Leave out rule changes (the home feed is about money). */
    skipChanges?: boolean;
  } = {},
): Promise<ActivityPage> {
  const fallback = base.meta.values().next().value as TokenMeta | undefined;
  const requests = new Map<string, SpendRequest>();
  const tasks = new Map<string, Task>();
  // Which rule changes still wait, so an applied change's "proposed" row drops its chip.
  const waiting = skipChanges
    ? null
    : await listQueued(budget)
        .then((l) => new Set(l.filter(([, c]) => c.status === "queued").map(([id]) => id)))
        .catch(() => null);
  const items: Activity[] = [];
  const keys = new Set<string>();
  let next: string | null = cursor ?? null;
  try {
    for (let i = 0; i < 6; i++) {
      const page = await contractEvents({ cursor: next ?? undefined });
      await Promise.all([fillRequests(page.events, requests), fillTasks(page.events, tasks)]);
      const rows = activityFeed(page.events, requests, (b) => base.meta.get(b) ?? fallback, {
        tasks,
        waiting,
      }).filter(
        (a) =>
          (budget === undefined || a.budget === budget) &&
          (account === undefined || a.people.includes(account)) &&
          (!skipPayments || a.requestId === null) &&
          (!skipChanges || !a.isChange),
      );
      // A payment's earlier steps can sit on an older history page: keep its newest row.
      for (const a of rows) {
        if (keys.has(a.key)) continue;
        keys.add(a.key);
        items.push(a);
      }
      next = page.next;
      if (!next || items.length >= FEED_PAGE) break;
    }
  } catch {
    return { items, next: null, loaded: items.length > 0 };
  }
  return { items, next, loaded: true };
}

/** Looks up the requests named by these events, so rows can say who paid whom and how much. */
async function fillRequests(events: EarmarkEvent[], into: Map<string, SpendRequest>) {
  const ids = [
    ...new Set(
      events.flatMap((e) =>
        typeof e.data.request_id === "string" && !into.has(e.data.request_id)
          ? [e.data.request_id]
          : [],
      ),
    ),
  ];
  const found = await Promise.all(ids.map(async (id) => [id, await getRequest(id)] as const));
  for (const [id, r] of found) if (r) into.set(id, r);
}

const TASK_EVENTS = new Set([
  "task_posted",
  "task_claimed",
  "claim_released",
  "work_submitted",
  "work_rejected",
  "task_accepted",
  "task_cancelled",
  "task_settled",
]);
/** Looks up the tasks named by these events (most carry only a task id). Never throws. */
async function fillTasks(events: EarmarkEvent[], into: Map<string, Task>) {
  const ids = [
    ...new Set(
      events.flatMap((e) =>
        TASK_EVENTS.has(e.event) && typeof e.data.task_id === "string" && !into.has(e.data.task_id)
          ? [e.data.task_id]
          : [],
      ),
    ),
  ];
  const found = await Promise.all(
    ids.map(async (id) => [id, await getTask(id).catch(() => null)] as const),
  );
  for (const [id, t] of found) if (t) into.set(id, t);
}
/** approver -> payments waiting in their budgets. Drives the Approvals tab and its badge. */
export async function approverQueue(): Promise<Record<string, number>> {
  try {
    const out: Record<string, number> = {};
    for (const b of await listBudgets()) {
      if (b.closed) continue;
      for (const a of b.approvers) out[a] = (out[a] ?? 0) + b.pending_requests.length;
    }
    return out;
  } catch {
    return {};
  }
}

export type PauseInfo = { by: string; ns: string };

/**
 * Who paused each paused budget or spender, and when: "budget|spender" (spender "" for the whole
 * budget) -> the latest pause. Reads recent history only (up to 600 transactions); a pause older
 * than that just shows without a name. Never throws: this is extra detail.
 */
export async function loadPauses(wanted: Set<string>): Promise<Map<string, PauseInfo>> {
  const out = new Map<string, PauseInfo>();
  if (wanted.size === 0) return out;
  try {
    let cursor: string | undefined;
    for (let i = 0; i < 3 && out.size < wanted.size; i++) {
      const page = await contractEvents({ cursor, limit: 200 });
      for (const e of page.events) {
        if (e.event !== "change_applied") continue;
        const change = e.data.change as Record<string, { spender?: string | null } | undefined>;
        if (!change || !("pause" in change)) continue;
        const key = `${String(e.data.envelope_id)}|${change.pause?.spender ?? ""}`;
        // Newest first, so the first pause seen for a key is the one in effect.
        if (wanted.has(key) && !out.has(key)) out.set(key, { by: e.signer, ns: e.timestampNs });
      }
      if (!page.next) break;
      cursor = page.next;
    }
  } catch {
    // History unavailable: pauses show without who and when.
  }
  return out;
}

const DECIDED = new Set(["spend_approved", "spend_rejected", "spend_expired"]);

/**
 * When each request was decided (approved, rejected or released): request id -> timestamp (ns).
 * Reads recent history only (up to 600 transactions). Never throws: this is extra detail.
 */
export async function loadDecisions(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    let cursor: string | undefined;
    for (let i = 0; i < 3; i++) {
      const page = await contractEvents({ cursor, limit: 200 });
      for (const e of page.events) {
        const id = e.data.request_id;
        if (DECIDED.has(e.event) && typeof id === "string" && !out.has(id)) {
          out.set(id, e.timestampNs);
        }
      }
      if (!page.next) break;
      cursor = page.next;
    }
  } catch {
    // History unavailable: rows show without a time.
  }
  return out;
}

/** Events of one request, oldest first: the timeline on the payment page. */
export async function requestEvents(requestId: string): Promise<EarmarkEvent[] | null> {
  try {
    const all = await allContractEvents();
    return all.filter((e) => e.data.request_id === requestId).reverse();
  } catch {
    return null;
  }
}
