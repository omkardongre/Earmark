// Server-side loaders shared by the pages.
import { type Activity, activityFeed } from "./activity";
import {
  allContractEvents,
  contractEvents,
  type EarmarkEvent,
  getConfig,
  getRequest,
  getToken,
  listBudgets,
  listRequests,
} from "./near";
import type { Budget, Config, SpendRequest, TokenMeta } from "./types";

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
  }: {
    cursor?: string | null | undefined;
    budget?: string | undefined;
    account?: string | undefined;
    /** Leave out payment rows, where a payments table already lists them. */
    skipPayments?: boolean;
  } = {},
): Promise<ActivityPage> {
  const fallback = base.meta.values().next().value as TokenMeta | undefined;
  const requests = new Map<string, SpendRequest>();
  const items: Activity[] = [];
  let next: string | null = cursor ?? null;
  try {
    for (let i = 0; i < 6; i++) {
      const page = await contractEvents({ cursor: next ?? undefined });
      await fillRequests(page.events, requests);
      const rows = activityFeed(page.events, requests, (b) => base.meta.get(b) ?? fallback).filter(
        (a) =>
          (budget === undefined || a.budget === budget) &&
          (account === undefined || a.people.includes(account)) &&
          (!skipPayments || a.requestId === null),
      );
      items.push(...rows);
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
