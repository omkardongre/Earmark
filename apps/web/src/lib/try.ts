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
  /** Small budget for the race: nothing paid at once, so a request only reserves funds. */
  raceEnvelope: "1",
  /** The lead is paused in this budget only, so the main budget stays open for everyone. */
  pausedEnvelope: "2",
};

const usdc = (n: number) => String(n * 1_000_000);
/** Planned amounts: 5 pays at once, 40 needs one approval (lowered to fit the budget's rules). */
const PAY = 5;
const ASK = 40;
export function amounts(budget: Pick<Budget, "one_approver_limit" | "spenders">) {
  const auto = BigInt(budget.spenders.find(([id]) => id === TRY.lead)?.[1].auto_limit ?? "0");
  const one = BigInt(budget.one_approver_limit);
  const min = (a: bigint, b: bigint) => (a < b ? a : b);
  return {
    pay: String(min(BigInt(usdc(PAY)), auto)),
    ask: String(min(BigInt(usdc(ASK)), one)),
  };
}

export const tryEnabled = () => !!process.env.TRY_LEAD_KEY && !!process.env.TRY_COUNCIL_KEY;

export const SCENES = [
  "pay",
  "ask",
  "approve",
  "unknown",
  "duplicate",
  "lead-approves",
  "race",
  "paused",
] as const;
export type Scene = (typeof SCENES)[number];

export type TryResult = {
  ok: boolean;
  /** Request status when the call went through. */
  status?: RequestStatus | null;
  /** Contract panic code, or `key_not_allowed` when NEAR itself refused the key. */
  reason?: string;
  tx?: string;
  requestId?: string;
  amount?: string;
  /** Race only: both requests, the one that went through first. */
  race?: TryResult[];
  /** Race only: what was left before the race. */
  available?: string;
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

type Call = { account: string; key: string | undefined; method: string; args: object; gas: number };

const send = (c: Call) => serial(c.account, () => exec(c));

/** Signs and sends one call. Callers hold the key's queue (`serial`). */
async function exec({ account, key, method, args, gas: gasTgas }: Call): Promise<TryResult> {
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
}

const random = () => crypto.randomUUID().slice(0, 12);

const lead = (args: object, method = "request_spend"): Call => ({
  account: TRY.lead,
  key: process.env.TRY_LEAD_KEY,
  method,
  args,
  gas: method === "request_spend" ? 80 : 30,
});
const council = (method: string, args: object): Call => ({
  account: TRY.council,
  key: process.env.TRY_COUNCIL_KEY,
  method,
  args,
  gas: method === "approve" ? 80 : 30,
});

/** A request_spend call. Ids start with `try-` only in budget 0, the only one the app approves. */
function spendCall(
  payee: string,
  amount: string,
  memo: string,
  work: string,
  envelope = TRY.envelope,
) {
  const prefix = envelope === TRY.envelope ? "try" : "side";
  const requestId = `${prefix}-${random()}`;
  const args = {
    envelope_id: envelope,
    request_id: requestId,
    payee,
    amount,
    memo,
    work_ref: work,
  };
  return { call: lead(args), requestId, amount };
}

function spend(payee: string, amount: string, memo: string, work: string, envelope?: string) {
  const s = spendCall(payee, amount, memo, work, envelope);
  return send(s.call).then((r) => ({ ...r, requestId: s.requestId, amount }));
}

/** Releases payments nobody approved in time, so the sandbox never fills up. */
async function expireOld(budget: Budget): Promise<number> {
  const now = BigInt(Date.now()) * 1_000_000n;
  const ttl = BigInt(budget.pending_ttl_secs) * 1_000_000_000n;
  let n = 0;
  for (const id of budget.pending_requests.slice(0, 5)) {
    const r = await view<SpendRequest | null>(TRY.contract, "get_request", { request_id: id });
    if (r && BigInt(r.created_at_ns) + ttl <= now) {
      const done = await send(council("expire", { request_id: id }));
      if (done.ok) n++;
    }
  }
  return n;
}

export const getTryBudget = (id = TRY.envelope) =>
  view<Budget>(TRY.contract, "get_envelope", { envelope_id: id });

/**
 * Two requests for more than half of what is left, sent at the same moment with the same key.
 * The contract runs them one after the other: the first reserves the funds, the second is
 * refused with `over_available`. Reservations expire after the race budget's 60 s window.
 */
async function race(): Promise<TryResult> {
  let budget = await getTryBudget(TRY.raceEnvelope);
  if (budget.pending_requests.length > 0 && (await expireOld(budget)) > 0) {
    budget = await getTryBudget(TRY.raceEnvelope);
  }
  // 60% of what is left, in whole cents: one fits, two don't.
  const amount = ((BigInt(budget.available) * 6n) / 10n / 10_000n) * 10_000n;
  if (amount < 1_000_000n) return { ok: false, reason: "race_busy" };
  const calls = [1, 2].map(() =>
    spendCall(
      TRY.writer,
      String(amount),
      "Same invoice",
      `https://try.earmark.example/${random()}`,
      TRY.raceEnvelope,
    ),
  );
  const results = await serial(TRY.lead, () =>
    Promise.all(calls.map((c) => exec(c.call).then((r) => ({ ...r, requestId: c.requestId })))),
  );
  results.sort((a, b) => Number(b.ok) - Number(a.ok));
  const [first, second] = results;
  return {
    ok: !!first?.ok && second?.reason === "over_available",
    amount: String(amount),
    available: budget.available,
    race: results,
  };
}

export async function runScene(scene: Scene, requestId?: string): Promise<TryResult> {
  const work = `https://try.earmark.example/${random()}`;
  const pay = usdc(PAY);
  switch (scene) {
    case "pay":
      return spend(TRY.writer, amounts(await getTryBudget()).pay, "Short article", work);
    case "ask": {
      const budget = await getTryBudget();
      if (budget.pending_requests.length > 0) await expireOld(budget);
      return spend(TRY.designer, amounts(budget).ask, "Cover design", work);
    }
    case "approve":
      return send(council("approve", { request_id: requestId })).then(
        (r): TryResult => (requestId ? { ...r, requestId } : r),
      );
    case "unknown":
      return spend("stranger.testnet", pay, "Guest post", work);
    case "duplicate":
      return spend(TRY.writer, pay, "First article", TRY.paidWork);
    case "lead-approves":
      // The lead's key tries a method it was never given.
      return send(lead({ request_id: "any" }, "approve"));
    case "race":
      return race();
    case "paused":
      return spend(TRY.writer, pay, "Short article", work, TRY.pausedEnvelope);
  }
}

/** Fixed-window limits kept in memory: per visitor, and for the whole sandbox. */
const WINDOW_MS = 10 * 60_000;
const PER_VISITOR = 20;
const TOTAL = 300;
const hits = new Map<string, { start: number; n: number }>();
/** `cost`: transactions the scene sends (the race sends two). */
export function allow(visitor: string, cost = 1): boolean {
  const now = Date.now();
  const take = (key: string, max: number) => {
    const h = hits.get(key);
    if (!h || now - h.start > WINDOW_MS) {
      hits.set(key, { start: now, n: cost });
      return true;
    }
    if (h.n + cost > max) return false;
    h.n += cost;
    return true;
  };
  if (hits.size > 5000) hits.clear();
  return take("*", TOTAL) && take(visitor, PER_VISITOR);
}
