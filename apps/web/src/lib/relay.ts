// Fees paid by Earmark (feature 8, docs/05 §4). Server only.
//
// A member signs a NEP-366 delegate action in their wallet; this relays it from the sponsor
// account, which pays the gas. The call still runs as the member (`predecessor_account_id`), so
// the contract checks their role as usual. These checks only stop strangers from spending the
// sponsor's NEAR: one call to our own contract, no deposit, a method the app uses, a sender who is
// in a budget, a valid signature from one of their keys, and daily caps.
import { createHash } from "node:crypto";
import { deserialize } from "borsh";
import {
  Account,
  actions,
  encodeDelegateAction,
  JsonRpcProvider,
  type KeyPairString,
  KeyType,
  PublicKey,
  SCHEMA,
  type SignedDelegate,
} from "near-api-js";
import { CONTRACT, NETWORK, RPC_URL } from "./config";
import { freeNear, listBudgets, rpcQuery } from "./near";
import { store } from "./store";

/** Methods the app calls with no deposit (docs/05 §4.2). Not setup, upgrades, DAO-only or close. */
export const RELAY_METHODS = new Set([
  "request_spend",
  "approve",
  "reject",
  "expire",
  "post_task",
  "claim_task",
  "release_claim",
  "submit_work",
  "reject_work",
  "accept_task",
  "cancel_task",
  "approve_payee",
  "approve_intents_payee",
  "remove_payee",
  "raise_limit",
  "lower_limit",
  "pause",
  "unpause",
  "apply_change",
  "cancel_change",
  "settle_escalation",
]);

export const MAX_GAS = 100n * 10n ** 12n;
const MAX_ARGS = 2048;
const NEAR = 10n ** 24n;
const milli = (n: number) => (BigInt(n) * NEAR) / 1000n;

/** Caps per network (docs/05 §4.5): calls per sender a day, NEAR a day, and the balance floor. */
export const CAPS =
  NETWORK === "mainnet"
    ? { perSender: 30, perDay: milli(300), floor: milli(300) }
    : { perSender: 50, perDay: milli(1000), floor: milli(300) };

export type Refusal =
  | "relay_off"
  | "bad_payload"
  | "wrong_contract"
  | "one_call_only"
  | "no_deposit"
  | "too_much_gas"
  | "args_too_big"
  | "method_not_sponsored"
  | "not_a_member"
  | "bad_signature"
  | "expired"
  | "daily_limit"
  | "relayer_low";

/** Plain words for each refusal, shown in the app. */
export const REFUSAL_TEXT: Record<Refusal, string> = {
  relay_off: "Earmark isn't covering fees right now.",
  bad_payload: "The wallet sent something Earmark can't read.",
  wrong_contract: "Earmark only covers fees for its own contract.",
  one_call_only: "Earmark only covers one call at a time.",
  no_deposit: "Earmark doesn't cover calls that attach NEAR.",
  too_much_gas: "This call asks for more gas than Earmark covers.",
  args_too_big: "This call is too big for Earmark to cover.",
  method_not_sponsored: "Earmark doesn't cover the fee for this action.",
  not_a_member: "Earmark covers fees only for people in a budget.",
  bad_signature: "The wallet's signature didn't check out.",
  expired: "The signature expired. Try again.",
  daily_limit: "Earmark has covered enough fees for today.",
  relayer_low: "Earmark's fee account is low.",
};

/** Base64 Borsh `SignedDelegate`, as wallets return it from `signDelegateActions`. */
export function decodeDelegate(b64: unknown): SignedDelegate | null {
  if (typeof b64 !== "string" || b64.length === 0 || b64.length > 8192) return null;
  try {
    return deserialize(SCHEMA.SignedDelegate, Buffer.from(b64, "base64")) as SignedDelegate;
  } catch {
    return null;
  }
}

/** The shape checks: no network, unit tested. Returns the method name when it passes. */
export function checkShape(
  sd: SignedDelegate,
  contract = CONTRACT,
): { ok: true; method: string; args: Record<string, unknown> } | { ok: false; reason: Refusal } {
  const d = sd.delegateAction;
  if (d.receiverId !== contract) return { ok: false, reason: "wrong_contract" };
  if (d.actions.length !== 1) return { ok: false, reason: "one_call_only" };
  const call = d.actions[0]?.functionCall;
  if (!call) return { ok: false, reason: "one_call_only" };
  if (BigInt(call.deposit) !== 0n) return { ok: false, reason: "no_deposit" };
  if (BigInt(call.gas) > MAX_GAS) return { ok: false, reason: "too_much_gas" };
  if (call.args.length > MAX_ARGS) return { ok: false, reason: "args_too_big" };
  if (!RELAY_METHODS.has(call.methodName)) return { ok: false, reason: "method_not_sponsored" };
  let args: unknown;
  try {
    args = JSON.parse(Buffer.from(call.args).toString("utf8"));
  } catch {
    return { ok: false, reason: "bad_payload" };
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, reason: "bad_payload" };
  }
  return { ok: true, method: call.methodName, args: args as Record<string, unknown> };
}

type Bytes = { data: ArrayLike<number> };

/**
 * Borsh gives a plain `{ ed25519Key: { data } }` with `data` as a number array; rebuild a
 * PublicKey (with a Uint8Array, which the verifier needs).
 */
function delegateKey(sd: SignedDelegate): PublicKey | null {
  const k = sd.delegateAction.publicKey as unknown as { ed25519Key?: Bytes; secp256k1Key?: Bytes };
  if (k.ed25519Key) {
    return new PublicKey({ keyType: KeyType.ED25519, data: Uint8Array.from(k.ed25519Key.data) });
  }
  if (k.secp256k1Key) {
    return new PublicKey({
      keyType: KeyType.SECP256K1,
      data: Uint8Array.from(k.secp256k1Key.data),
    });
  }
  return null;
}

function signatureBytes(sd: SignedDelegate): Uint8Array | null {
  const s = sd.signature as unknown as { ed25519Signature?: Bytes; secp256k1Signature?: Bytes };
  const data = s.ed25519Signature?.data ?? s.secp256k1Signature?.data;
  return data ? Uint8Array.from(data) : null;
}

/** NEP-461: the wallet signs sha256(prefix ‖ borsh(DelegateAction)). */
export function signatureValid(sd: SignedDelegate): boolean {
  const key = delegateKey(sd);
  const sig = signatureBytes(sd);
  if (!key || !sig) return false;
  const hash = createHash("sha256").update(encodeDelegateAction(sd.delegateAction)).digest();
  try {
    return key.verify(new Uint8Array(hash), sig);
  } catch {
    return false;
  }
}

type AccessKeyView = {
  block_height: number;
  nonce: number;
  permission:
    | "FullAccess"
    | { FunctionCall: { receiver_id: string; method_names: string[] } }
    | Record<string, unknown>;
};

/** The key exists on the sender's account and may make this call; and the signature is fresh. */
async function checkKey(sd: SignedDelegate, method: string): Promise<Refusal | null> {
  const d = sd.delegateAction;
  const key = delegateKey(sd);
  if (!key) return "bad_signature";
  let ak: AccessKeyView;
  try {
    ak = (
      await rpcQuery<AccessKeyView>({
        request_type: "view_access_key",
        finality: "final",
        account_id: d.senderId,
        public_key: key.toString(),
      })
    ).value;
  } catch {
    return "bad_signature";
  }
  if (BigInt(d.maxBlockHeight) <= BigInt(ak.block_height)) return "expired";
  if (BigInt(d.nonce) <= BigInt(ak.nonce)) return "expired";
  const p = ak.permission;
  if (p !== "FullAccess") {
    const fc = (p as { FunctionCall?: { receiver_id: string; method_names: string[] } })
      .FunctionCall;
    if (!fc || fc.receiver_id !== CONTRACT) return "bad_signature";
    if (fc.method_names.length > 0 && !fc.method_names.includes(method)) return "bad_signature";
  }
  return null;
}

/** Everyone with a role in an open budget: spenders (leads), approvers and payees. */
let members: { at: number; ids: Set<string> } | null = null;
async function isMember(account: string): Promise<boolean> {
  if (!members || Date.now() - members.at > 60_000) {
    const budgets = await listBudgets();
    const ids = new Set<string>();
    for (const b of budgets) {
      if (b.closed) continue;
      for (const [s] of b.spenders) ids.add(s);
      for (const a of b.approvers) ids.add(a);
      for (const p of b.payees) ids.add(p);
    }
    members = { at: Date.now(), ids };
  }
  return members.ids.has(account);
}

const day = () => new Date().toISOString().slice(0, 10);
type DayCount = { burnt: string; senders: Record<string, number> };

async function underCaps(sender: string): Promise<Refusal | null> {
  const today = (await store.get<DayCount>("relay", `${NETWORK}:${day()}`)) ?? {
    burnt: "0",
    senders: {},
  };
  if ((today.senders[sender] ?? 0) >= CAPS.perSender) return "daily_limit";
  if (BigInt(today.burnt) >= CAPS.perDay) return "daily_limit";
  return null;
}

async function count(sender: string, burnt: bigint) {
  const id = `${NETWORK}:${day()}`;
  const today = (await store.get<DayCount>("relay", id)) ?? { burnt: "0", senders: {} };
  today.senders[sender] = (today.senders[sender] ?? 0) + 1;
  today.burnt = String(BigInt(today.burnt) + burnt);
  await store.set("relay", id, today);
}

export const relayEnabled = () =>
  !!process.env.RELAYER_ACCOUNT && !!process.env.RELAYER_KEY && process.env.RELAY_OFF !== "1";

let sponsor: Account | null = null;
function sponsorAccount(): Account {
  sponsor ??= new Account(
    process.env.RELAYER_ACCOUNT as string,
    new JsonRpcProvider({ url: RPC_URL }),
    process.env.RELAYER_KEY as KeyPairString,
  );
  return sponsor;
}

/** One relay at a time: the sponsor key's nonce and the daily counts stay in order. */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

type Outcome = {
  transaction: { hash: string };
  transaction_outcome: { outcome: { tokens_burnt: string } };
  status: { SuccessValue?: string; Failure?: unknown };
  receipts_outcome: {
    outcome: { tokens_burnt: string; executor_id: string; status: Record<string, unknown> };
  }[];
};

export type RelayResult =
  | { ok: true; outcome: Outcome }
  | { ok: false; reason: Refusal; status: number };

/** Checks one signed delegate and, if it passes, relays it from the sponsor account. */
export async function relay(b64: unknown): Promise<RelayResult> {
  if (!relayEnabled()) return { ok: false, reason: "relay_off", status: 503 };
  const sd = decodeDelegate(b64);
  if (!sd) return { ok: false, reason: "bad_payload", status: 400 };
  const shape = checkShape(sd);
  if (!shape.ok) return { ok: false, reason: shape.reason, status: 403 };
  if (!signatureValid(sd)) return { ok: false, reason: "bad_signature", status: 403 };
  const sender = sd.delegateAction.senderId;
  if (!(await isMember(sender))) return { ok: false, reason: "not_a_member", status: 403 };
  const keyProblem = await checkKey(sd, shape.method);
  if (keyProblem) return { ok: false, reason: keyProblem, status: 403 };
  return serial(async () => {
    const capped = await underCaps(sender);
    if (capped) return { ok: false, reason: capped, status: 429 };
    if ((await freeNear(process.env.RELAYER_ACCOUNT as string)) < CAPS.floor) {
      return { ok: false, reason: "relayer_low", status: 503 };
    }
    const outcome = (await sponsorAccount().signAndSendTransaction({
      receiverId: sender,
      actions: [actions.signedDelegate(sd)],
      waitUntil: "EXECUTED_OPTIMISTIC",
      throwOnFailure: false,
    })) as unknown as Outcome;
    // A failed call still burns gas, so it counts against the caps too.
    const burnt =
      BigInt(outcome.transaction_outcome.outcome.tokens_burnt) +
      outcome.receipts_outcome.reduce((s, r) => s + BigInt(r.outcome.tokens_burnt), 0n);
    await count(sender, burnt);
    return { ok: true as const, outcome };
  });
}
