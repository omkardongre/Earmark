// Read-only chain access: contract views over JSON-RPC, and the transaction behind each Earmark
// event (FastNEAR tx API). Runs on the server and in the browser; no keys.
import { CONTRACT, RPC_URL, TX_API } from "./config";
import type { Budget, Config, QueuedChange, SpenderRecord, SpendRequest, TokenMeta } from "./types";

const toBase64 = (s: string) =>
  typeof window === "undefined"
    ? Buffer.from(s).toString("base64")
    : btoa(Array.from(new TextEncoder().encode(s), (b) => String.fromCharCode(b)).join(""));
const fromBytes = (b: number[]) => new TextDecoder().decode(new Uint8Array(b));

export class ViewError extends Error {}

export async function view<T>(contract: string, method: string, args: object = {}): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "earmark",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "optimistic",
        account_id: contract,
        method_name: method,
        args_base64: toBase64(JSON.stringify(args)),
      },
    }),
    cache: "no-store",
  });
  if (!res.ok) throw new ViewError(`RPC ${res.status}`);
  const body = (await res.json()) as {
    result?: { result?: number[]; error?: string };
    error?: { cause?: { name?: string }; message?: string };
  };
  if (body.error) throw new ViewError(body.error.cause?.name ?? body.error.message ?? "rpc_error");
  if (!body.result?.result) throw new ViewError(body.result?.error ?? "view_failed");
  return JSON.parse(fromBytes(body.result.result)) as T;
}

export const getConfig = () => view<Config>(CONTRACT, "get_config");
export const getBudget = (id: string) =>
  view<Budget | null>(CONTRACT, "get_envelope", { envelope_id: id });
export const listBudgets = () => view<Budget[]>(CONTRACT, "list_envelopes", {});
export const getRecord = (account: string) =>
  view<SpenderRecord>(CONTRACT, "get_record", { account_id: account });
export const isEligible = (account: string) =>
  view<boolean>(CONTRACT, "eligible", { account_id: account });
export const listQueued = (budget?: string) =>
  view<[string, QueuedChange][]>(CONTRACT, "list_queued", budget ? { envelope_id: budget } : {});
export const getRequest = (id: string) =>
  view<SpendRequest | null>(CONTRACT, "get_request", { request_id: id });

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

export type EarmarkEvent = {
  event: string;
  data: Record<string, unknown>;
  tx: string;
  /** Who signed the transaction (e.g. the approver who paused someone). */
  signer: string;
  timestampNs: string;
};

type AccountTxs = {
  account_txs: { transaction_hash: string; tx_block_timestamp: string }[];
  resume_token?: string;
};
type TxDetail = {
  transaction: { hash: string; signer_id: string };
  receipts: {
    receipt: { receiver_id: string };
    execution_outcome: { outcome: { logs: string[] } };
  }[];
};

/** Transactions per page of history. The API allows 200; a page of 30 keeps the first view fast. */
export const HISTORY_PAGE = 30;

async function txApi<T>(path: string, body: object): Promise<T> {
  const res = await fetch(`${TX_API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    // No data cache: a cached page of history hid new payments until a second reload.
    cache: "no-store",
  });
  if (!res.ok) throw new ViewError(`tx api ${res.status}`);
  return (await res.json()) as T;
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
            signer: tx.transaction.signer_id,
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
