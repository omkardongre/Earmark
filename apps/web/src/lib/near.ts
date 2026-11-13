// Read-only chain access: contract views over JSON-RPC, and the transaction behind each Earmark
// event (FastNEAR tx API). Runs on the server and in the browser; no keys.
//
// Reads try each node in RPC_URLS in turn. If all fail, the server answers with the last good
// value for the same request (kept in memory, per instance) and marks the data stale, so a page
// shows slightly old numbers with a notice instead of an error. The browser never gets cached
// values: its reads follow a user action (a payment check, a refresh) and must be live.
import { CONTRACT, READ_TIMEOUT_MS, RPC_URLS, TX_API } from "./config";
import type {
  Budget,
  Config,
  PayeeRecord,
  QueuedChange,
  SpenderRecord,
  SpendRequest,
  Task,
  TaskRules,
  TokenMeta,
  TrustView,
} from "./types";

const toBase64 = (s: string) =>
  typeof window === "undefined"
    ? Buffer.from(s).toString("base64")
    : btoa(Array.from(new TextEncoder().encode(s), (b) => String.fromCharCode(b)).join(""));
const fromBytes = (b: number[]) => new TextDecoder().decode(new Uint8Array(b));

export class ViewError extends Error {}

/** A node or network problem: worth trying the next node, then the last good value. */
class Unavailable extends Error {}

/** How fresh a value is: `at` is when it was read live (ms); `stale` if it came from memory. */
export type ReadMeta = { stale: boolean; at: number };
export type Read<T> = ReadMeta & { value: T };

type Source = "rpc" | "tx";
type Store = {
  values: Map<string, { value: unknown; at: number }>;
  /** Per source: the oldest last-good time served since the last live read, or null. */
  staleSince: Record<Source, number | null>;
};
const SERVER = typeof window === "undefined";
const MAX_ENTRIES = 2000;
// On globalThis so every route bundle in the process shares one store.
const g = globalThis as { __earmarkReads?: Store };
g.__earmarkReads ??= { values: new Map(), staleSince: { rpc: null, tx: null } };
const store: Store = g.__earmarkReads;

/** Runs a live read; on a node problem serves the last good value (server only). */
async function withLastGood<T>(
  source: Source,
  key: string,
  live: () => Promise<T>,
): Promise<Read<T>> {
  try {
    const value = await live();
    const at = Date.now();
    if (SERVER) {
      store.values.delete(key);
      store.values.set(key, { value, at });
      if (store.values.size > MAX_ENTRIES) {
        const oldest = store.values.keys().next().value;
        if (oldest !== undefined) store.values.delete(oldest);
      }
      store.staleSince[source] = null;
    }
    return { value, at, stale: false };
  } catch (e) {
    const last = SERVER && e instanceof Unavailable ? store.values.get(key) : undefined;
    if (!last) throw e instanceof Unavailable ? new ViewError(e.message) : e;
    const since = store.staleSince[source];
    store.staleSince[source] = since === null ? last.at : Math.min(since, last.at);
    return { value: last.value as T, at: last.at, stale: true };
  }
}

/**
 * When the oldest value a recent server read fell back to was read live (ms), or null when reads
 * are live. Pages use it to show "Live data is loading, showing values from <time>".
 */
export function staleSince(): number | null {
  const { rpc, tx } = store.staleSince;
  if (rpc === null) return tx;
  return tx === null ? rpc : Math.min(rpc, tx);
}

// Errors that are the chain's real answer (a contract panic, an unknown account): no failover.
// Anything else (timeouts, 5xx, 429, a node that isn't synced) moves on to the next node.
const NODE_TROUBLE = new Set([
  "UNKNOWN_BLOCK",
  "NO_SYNCED_BLOCKS",
  "UNAVAILABLE_SHARD",
  "NOT_SYNCED_YET",
]);

async function post(url: string, body: object): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Unavailable(e instanceof Error ? e.message : "network_error");
  }
}

async function rpcOnce<T>(url: string, params: object): Promise<T> {
  const res = await post(url, { jsonrpc: "2.0", id: "earmark", method: "query", params });
  if (!res.ok) throw new Unavailable(`RPC ${res.status}`);
  let body: {
    result?: T;
    error?: { name?: string; cause?: { name?: string }; message?: string };
  };
  try {
    body = await res.json();
  } catch {
    throw new Unavailable("RPC bad_json");
  }
  if (body.error) {
    const cause = body.error.cause?.name ?? body.error.message ?? "rpc_error";
    const real =
      body.error.name === "HANDLER_ERROR" || body.error.name === "REQUEST_VALIDATION_ERROR";
    throw real && !NODE_TROUBLE.has(cause) ? new ViewError(cause) : new Unavailable(cause);
  }
  if (body.result === undefined) throw new Unavailable("RPC empty");
  return body.result;
}

/** One `query` call, trying each node in RPC_URLS, then the last good answer. */
export function rpcQuery<T>(params: object): Promise<Read<T>> {
  return withLastGood("rpc", `rpc ${JSON.stringify(params)}`, async () => {
    let last: unknown;
    for (const url of RPC_URLS) {
      try {
        return await rpcOnce<T>(url, params);
      } catch (e) {
        if (!(e instanceof Unavailable)) throw e;
        last = e;
      }
    }
    throw last ?? new Unavailable("no RPC configured");
  });
}

/** A contract view with its freshness. */
export async function viewRead<T>(
  contract: string,
  method: string,
  args: object = {},
): Promise<Read<T>> {
  const r = await rpcQuery<{ result?: number[]; error?: string }>({
    request_type: "call_function",
    finality: "optimistic",
    account_id: contract,
    method_name: method,
    args_base64: toBase64(JSON.stringify(args)),
  });
  if (!r.value.result) throw new ViewError(r.value.error ?? "view_failed");
  return { ...r, value: JSON.parse(fromBytes(r.value.result)) as T };
}

export async function view<T>(contract: string, method: string, args: object = {}): Promise<T> {
  return (await viewRead<T>(contract, method, args)).value;
}

export type AccountView = {
  amount: string;
  code_hash: string;
  /** Set when the account runs a global contract (newer Sputnik DAOs do). */
  global_contract_hash?: string;
  storage_usage: number;
};
export const viewAccount = (account: string) =>
  rpcQuery<AccountView>({ request_type: "view_account", finality: "final", account_id: account });

/** NEAR storage price: 1e19 yoctoNEAR per byte. */
const STORAGE_PRICE = 10n ** 19n;
/** NEAR an account can spend: its balance minus what its stored bytes lock. */
export async function freeNear(account: string): Promise<bigint> {
  const { value } = await viewAccount(account);
  return BigInt(value.amount) - BigInt(value.storage_usage) * STORAGE_PRICE;
}
/** The contract's `STORAGE_RESERVE` (spend.rs): new payments stop below this much free NEAR. */
export const PAYMENT_RESERVE = 5n * 10n ** 23n;
/**
 * NEAR to send the contract so new payments can go through: up to the reserve plus 0.05 NEAR of
 * headroom, rounded up to 0.01. Zero when it has enough.
 */
export async function contractTopUp(): Promise<{ free: bigint; needed: bigint }> {
  const free = await freeNear(CONTRACT);
  if (free >= PAYMENT_RESERVE) return { free, needed: 0n };
  const step = 10n ** 22n;
  const gap = PAYMENT_RESERVE + 5n * step - free;
  return { free, needed: ((gap + step - 1n) / step) * step };
}
export type AccessKeyView = {
  public_key: string;
  access_key: { permission: "FullAccess" | Record<string, unknown> };
};
export const accessKeyList = (account: string) =>
  rpcQuery<{ keys: AccessKeyView[] }>({
    request_type: "view_access_key_list",
    finality: "final",
    account_id: account,
    limit: 100,
  });

export const getConfig = () => view<Config>(CONTRACT, "get_config");
export const getBudget = (id: string) =>
  view<Budget | null>(CONTRACT, "get_envelope", { envelope_id: id });
export const listBudgets = () => view<Budget[]>(CONTRACT, "list_envelopes", {});
export const getRecord = (account: string) =>
  view<SpenderRecord>(CONTRACT, "get_record", { account_id: account });
export const getPayeeRecord = (account: string) =>
  view<PayeeRecord>(CONTRACT, "get_payee_record", { account_id: account });
export const isEligible = (account: string) =>
  view<boolean>(CONTRACT, "eligible", { account_id: account });
export const listQueued = (budget?: string) =>
  view<[string, QueuedChange][]>(CONTRACT, "list_queued", budget ? { envelope_id: budget } : {});
export const getRequest = (id: string) =>
  view<SpendRequest | null>(CONTRACT, "get_request", { request_id: id });

/**
 * A contract deployed before tasks has no task methods. Its views fail with "MethodNotFound";
 * the app then treats tasks as not available instead of failing the page.
 */
async function taskView<T>(method: string, args: object): Promise<T | null> {
  try {
    return await view<T>(CONTRACT, method, args);
  } catch (e) {
    if (/MethodNotFound|MethodResolveError/i.test(String(e))) return null;
    throw e;
  }
}
/** A budget's tasks, newest first; null if the contract has no tasks yet. */
export const listTasks = (budget: string, { from = 0, limit = 100 } = {}) =>
  taskView<[string, Task][]>("list_tasks", {
    envelope_id: budget,
    from_index: String(from),
    limit,
  });
export const getTask = (id: string) => taskView<Task | null>("get_task", { task_id: id });
export const getTaskRules = (budget: string) =>
  taskView<TaskRules>("get_task_rules", { envelope_id: budget });
export const getTrust = (budget: string, account: string) =>
  taskView<TrustView>("get_contributor_trust", { envelope_id: budget, account_id: account });

/** A budget's requests, newest first; `from` skips that many of the newest. */
export async function listRequests(
  budget: string,
  { from = 0, limit = 100 }: { from?: number; limit?: number } = {},
): Promise<[string, SpendRequest][]> {
  return view<[string, SpendRequest][]>(CONTRACT, "list_requests", {
    envelope_id: budget,
    from_index: String(from),
    limit,
  });
}

const tokenMeta = new Map<string, Promise<TokenMeta>>();
export function getToken(token: string): Promise<TokenMeta> {
  let meta = tokenMeta.get(token);
  if (!meta) {
    meta = view<TokenMeta>(token, "ft_metadata");
    // A failed read isn't kept, so the next page tries again.
    meta.catch(() => tokenMeta.delete(token));
    tokenMeta.set(token, meta);
  }
  return meta;
}

export type DaoProposal = {
  id: number;
  proposer: string;
  description: string;
  status: string;
  kind: Record<string, unknown>;
  submission_time: string;
};
export const getProposal = (dao: string, id: number) =>
  view<DaoProposal>(dao, "get_proposal", { id });

/** The DAO's newest proposal that funds this budget (a Transfer to the contract naming it). */
export async function findFunding(
  dao: string,
  budgetId: string,
  scan = 50,
): Promise<DaoProposal | null> {
  const last = await view<number>(dao, "get_last_proposal_id");
  const from = Math.max(0, last - scan);
  const page = await view<DaoProposal[]>(dao, "get_proposals", { from_index: from, limit: scan });
  const funds = page.filter((p) => {
    const t = (p.kind as { Transfer?: { receiver_id: string; msg?: string | null } }).Transfer;
    if (t?.receiver_id !== CONTRACT || !t.msg) return false;
    try {
      return (JSON.parse(t.msg) as { envelope_id?: string }).envelope_id === budgetId;
    } catch {
      return false;
    }
  });
  return funds.sort((a, b) => b.id - a.id)[0] ?? null;
}

export type EarmarkEvent = {
  event: string;
  data: Record<string, unknown>;
  tx: string;
  /**
   * Who acted (e.g. the approver who paused someone): the account that called the contract. With
   * fees paid by Earmark (NEP-366) that differs from the transaction's signer, the relayer.
   */
  signer: string;
  /** Someone else (Earmark's relayer) paid this transaction's network fee. */
  sponsored: boolean;
  timestampNs: string;
};

type AccountTxs = {
  account_txs: { transaction_hash: string; tx_block_timestamp: string }[];
  resume_token?: string;
};
type TxDetail = {
  transaction: {
    hash: string;
    signer_id: string;
    actions?: { Delegate?: { delegate_action: { sender_id: string } } }[];
  };
  receipts: {
    receipt: { receiver_id: string };
    execution_outcome: { outcome: { logs: string[] } };
  }[];
};

/** Transactions per page of history. The API allows 200; a page of 30 keeps the first view fast. */
export const HISTORY_PAGE = 30;

/** A FastNEAR tx API call with its freshness (no second provider, so: live, then last good). */
export function txApiRead<T>(path: string, body: object): Promise<Read<T>> {
  return withLastGood("tx", `tx ${path} ${JSON.stringify(body)}`, async () => {
    // No data cache (`post` uses no-store): a cached page of history hid new payments.
    const res = await post(`${TX_API}${path}`, body);
    if (!res.ok) throw new Unavailable(`tx api ${res.status}`);
    try {
      return (await res.json()) as T;
    } catch {
      throw new Unavailable("tx api bad_json");
    }
  });
}

async function txApi<T>(path: string, body: object): Promise<T> {
  return (await txApiRead<T>(path, body)).value;
}

/**
 * One page of Earmark events, newest first, each with the transaction it came from.
 * `cursor` is the FastNEAR resume token of the previous page; `next` is null on the last page.
 */
export async function contractEvents({
  cursor,
  limit = HISTORY_PAGE,
  contract = CONTRACT,
}: {
  cursor?: string | undefined;
  limit?: number;
  contract?: string;
} = {}): Promise<{ events: EarmarkEvent[]; next: string | null }> {
  const page = await txApi<AccountTxs>("/v0/account", {
    account_id: contract,
    limit,
    ...(cursor ? { resume_token: cursor } : {}),
  });
  const time = new Map(page.account_txs.map((t) => [t.transaction_hash, t.tx_block_timestamp]));
  // A transaction indexed seconds ago can be listed twice; count each one once.
  const hashes = [...new Set(page.account_txs.map((t) => t.transaction_hash))];
  const batches: string[][] = [];
  for (let i = 0; i < hashes.length; i += 20) batches.push(hashes.slice(i, i + 20));
  const details = (
    await Promise.all(
      batches.map((b) => txApi<{ transactions: TxDetail[] }>("/v0/transactions", { tx_hashes: b })),
    )
  ).flatMap((r) => r.transactions);

  const events: EarmarkEvent[] = [];
  for (const tx of details) {
    const inTx: EarmarkEvent[] = [];
    // A relayed call (NEP-366) is signed by Earmark's relayer; the member is the delegate sender.
    const signer = tx.transaction.signer_id;
    const actor =
      tx.transaction.actions?.find((a) => a.Delegate)?.Delegate?.delegate_action.sender_id ??
      signer;
    for (const r of tx.receipts) {
      if (r.receipt.receiver_id !== contract) continue;
      for (const log of r.execution_outcome.outcome.logs) {
        if (!log.startsWith("EVENT_JSON:")) continue;
        try {
          const e = JSON.parse(log.slice("EVENT_JSON:".length)) as {
            standard: string;
            event: string;
            data: Record<string, unknown>;
          };
          if (e.standard !== "earmark") continue;
          inTx.push({
            event: e.event,
            data: e.data,
            tx: tx.transaction.hash,
            signer: actor,
            sponsored: actor !== signer,
            timestampNs: time.get(tx.transaction.hash) ?? "0",
          });
        } catch {
          // A log that isn't valid JSON isn't an Earmark event.
        }
      }
    }
    // Newest first, also inside one transaction (approve, then paid).
    events.push(...inTx.reverse());
  }
  events.sort((a, b) => {
    const d = BigInt(b.timestampNs) - BigInt(a.timestampNs);
    return d > 0n ? 1 : d < 0n ? -1 : 0;
  });
  return { events, next: page.resume_token ?? null };
}

/** Every event, following the cursor (capped, so a huge history can't stall a page). */
export async function allContractEvents(maxPages = 10): Promise<EarmarkEvent[]> {
  const out: EarmarkEvent[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const { events, next } = await contractEvents({ cursor, limit: 200 });
    out.push(...events);
    if (!next) break;
    cursor = next;
  }
  return out;
}
