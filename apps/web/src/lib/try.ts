// "Try it" sandbox, server side only (imported by the route handler and the page). The server
// signs with two testnet function-call keys from env (Secret Manager when hosted): the demo
// lead's key can call only `request_spend`, the demo council member's only `approve` and
// `expire`, both only on the sandbox contract. Visitors pick a scene; they never send amounts,
// payees or ids, except the id of a payment waiting for approval.
import { Account, actions, JsonRpcProvider, type KeyPairString } from "near-api-js";
import { RPC_URL } from "./config";
import { view } from "./near";
import type { Budget, RequestStatus, SpendRequest } from "./types";

export const TRY = {
  contract: process.env.TRY_CONTRACT ?? "try.earmark.testnet",
  lead: process.env.TRY_LEAD_ACCOUNT ?? "try-lead.earmark.testnet",
  council: process.env.TRY_COUNCIL_ACCOUNT ?? "try-council.earmark.testnet",
  writer: "try-writer.earmark.testnet",
  designer: "try-designer.earmark.testnet",
  /** Paid once at setup, so paying it again is refused. */
  paidWork: "https://try.earmark.example/already-paid",
  envelope: "0",
};

export const tryEnabled = () => !!process.env.TRY_LEAD_KEY && !!process.env.TRY_COUNCIL_KEY;

export type Scene = "pay" | "ask" | "approve" | "unknown" | "duplicate" | "lead-approves";
export const SCENES: Scene[] = ["pay", "ask", "approve", "unknown", "duplicate", "lead-approves"];

export type TryResult = {
  ok: boolean;
  /** Request status when the call went through. */
  status?: RequestStatus | null;
  /** Contract panic code, or `key_not_allowed` when NEAR itself refused the key. */
  reason?: string;
  tx?: string;
  requestId?: string;
};

const provider = new JsonRpcProvider({ url: RPC_URL });
const signers = new Map<string, Account>();
function signer(account: string, key: string | undefined): Account {
  if (!key) throw new Error("try_disabled");
  let s = signers.get(account);
  if (!s) {
    s = new Account(account, provider, key as KeyPairString);
    signers.set(account, s);
  }
  return s;
}

/** One transaction at a time per key, so two visitors never race for the same nonce. */
const queues = new Map<string, Promise<unknown>>();
function serial<T>(account: string, run: () => Promise<T>): Promise<T> {
  const prev = queues.get(account) ?? Promise.resolve();
  const next = prev.then(run, run);
  queues.set(
    account,
    next.catch(() => {}),
  );
  return next;
}

type Outcome = {
  transaction: { hash: string };
  status: { SuccessValue?: string; Failure?: unknown };
  receipts_outcome: { outcome: { status: { Failure?: unknown } } }[];
};

async function send(
  account: string,
  key: string | undefined,
  method: string,
  args: object,
  gasTgas: number,
): Promise<TryResult> {
  return serial(account, async () => {
    try {
      const o = (await signer(account, key).signAndSendTransaction({
        receiverId: TRY.contract,
        actions: [actions.functionCall(method, args, BigInt(gasTgas) * 10n ** 12n, 0n)],
        waitUntil: "EXECUTED_OPTIMISTIC",
        throwOnFailure: false,
      })) as unknown as Outcome;
      const failure =
        o.receipts_outcome.map((r) => r.outcome.status.Failure).find(Boolean) ?? o.status.Failure;
      if (failure) {
        const text = JSON.stringify(failure);
        const code = text.match(/Smart contract panicked: ([a-z_]+)/)?.[1] ?? "failed";
        return { ok: false, reason: code, tx: o.transaction.hash };
      }
      const raw = o.status.SuccessValue;
      const value = raw ? JSON.parse(Buffer.from(raw, "base64").toString()) : null;
      return { ok: true, status: value as RequestStatus | null, tx: o.transaction.hash };
    } catch (e) {
      // The protocol rejects a key used for a method it doesn't allow before any code runs.
      const text = String(e instanceof Error ? `${e.name} ${e.message}` : e);
      if (/MethodNameMismatch|ReceiverMismatch|does not allow method/i.test(text)) {
        return { ok: false, reason: "key_not_allowed" };
      }
      throw e;
    }
  });
}

const random = () => crypto.randomUUID().slice(0, 12);

function spend(payee: string, amount: string, work: string, memo: string) {
  const requestId = `try-${random()}`;
  return send(
    TRY.lead,
    process.env.TRY_LEAD_KEY,
    "request_spend",
    { envelope_id: TRY.envelope, request_id: requestId, payee, amount, memo, work_ref: work },
    80,
  ).then((r) => ({ ...r, requestId }));
}

/** Releases payments nobody approved in time, so the sandbox never fills up. */
async function expireOld(budget: Budget) {
  const now = BigInt(Date.now()) * 1_000_000n;
  const ttl = BigInt(budget.pending_ttl_secs) * 1_000_000_000n;
  for (const id of budget.pending_requests.slice(0, 5)) {
    const r = await view<SpendRequest | null>(TRY.contract, "get_request", { request_id: id });
    if (r && BigInt(r.created_at_ns) + ttl <= now) {
      await send(TRY.council, process.env.TRY_COUNCIL_KEY, "expire", { request_id: id }, 30);
    }
  }
}

export const getTryBudget = () =>
  view<Budget>(TRY.contract, "get_envelope", { envelope_id: TRY.envelope });

export async function runScene(scene: Scene, requestId?: string): Promise<TryResult> {
  const work = `https://try.earmark.example/${random()}`;
  switch (scene) {
    case "pay":
      return spend(TRY.writer, "3000000", work, "Short article");
    case "ask": {
      const budget = await getTryBudget();
      if (budget.pending_requests.length > 0) await expireOld(budget);
      return spend(TRY.designer, "20000000", work, "Cover design");
    }
    case "approve":
      return send(
        TRY.council,
        process.env.TRY_COUNCIL_KEY,
        "approve",
        { request_id: requestId },
        80,
      ).then((r): TryResult => (requestId ? { ...r, requestId } : r));
    case "unknown":
      return spend("stranger.testnet", "3000000", work, "Guest post");
    case "duplicate":
      return spend(TRY.writer, "3000000", TRY.paidWork, "First article");
    case "lead-approves":
      // The lead's key tries a method it was never given.
      return send(TRY.lead, process.env.TRY_LEAD_KEY, "approve", { request_id: "any" }, 30);
  }
}

/** Fixed-window limits kept in memory: per visitor, and for the whole sandbox. */
const WINDOW_MS = 10 * 60_000;
const PER_VISITOR = 20;
const TOTAL = 300;
const hits = new Map<string, { start: number; n: number }>();
export function allow(visitor: string): boolean {
  const now = Date.now();
  const take = (key: string, max: number) => {
    const h = hits.get(key);
    if (!h || now - h.start > WINDOW_MS) {
      hits.set(key, { start: now, n: 1 });
      return true;
    }
    if (h.n >= max) return false;
    h.n++;
    return true;
  };
  if (hits.size > 5000) hits.clear();
  return take("*", TOTAL) && take(visitor, PER_VISITOR);
}
