// `make attacks`: sends calls the contract (or NEAR itself) must refuse, on the testnet demo
// budget, and records each refused transaction in fixtures/testnet-attacks.json. `make verify`
// then re-reads every one on chain, with no keys, and checks it still shows the same refusal.
// Testnet only; needs maya's key in ~/.near-credentials. Each run adds nothing to the budget:
// every call here fails, so no money moves.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { actions, encodeSignedDelegate } from "near-api-js";
import { type CallResult, call, keychainAccount, view } from "../lib/near.ts";

const network = "testnet";
const CONTRACT = "budgets.earmark.testnet";
const BUDGET = "0";
const LEAD = "maya.earmark.testnet";
const APP = (process.env.APP ?? "https://earmark-878141445235.us-central1.run.app").replace(
  /\/$/,
  "",
);
const TGAS = 10n ** 12n;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

type Request = { spender: string; payee: string; work_ref: string; status: string; amount: string };
type Attack = { step: string; label: string; expect: string; tx: string; signer: string };

const maya = keychainAccount(network, LEAD);
const out: Attack[] = [];

/** Records a refused call; a call that went through is a broken promise and stops the run. */
function record(step: string, label: string, expect: string, r: CallResult, signer = LEAD) {
  const refused = !r.ok && r.error?.includes(expect);
  console.log(`${refused ? "refused" : "NOT REFUSED"}  ${label}  (${r.error ?? "ok"}) ${r.hash}`);
  if (!refused) throw new Error(`${label}: expected ${expect}, got ${r.error ?? "success"}`);
  out.push({ step, label, expect, tx: r.hash, signer });
}

const requests: [string, Request][] = await view(network, CONTRACT, "list_requests", {
  envelope_id: BUDGET,
  from_index: "0",
  limit: 100,
});
const paid = requests.find(([, r]) => r.spender === LEAD && r.status === "paid" && r.work_ref);
const budget = await view<{ payees: string[]; pending_requests: string[] }>(
  network,
  CONTRACT,
  "get_envelope",
  { envelope_id: BUDGET },
);
const [payee] = budget.payees;
const [pending] = budget.pending_requests;
if (!paid || !payee) throw new Error("budget 0 needs a paid request by maya and a payee");
const spend = (over: Partial<Record<string, string>>) => ({
  envelope_id: BUDGET,
  request_id: `attack-${randomUUID().slice(0, 12)}`,
  payee,
  amount: "1000000",
  memo: "Refusal check",
  work_ref: `https://earmark.example/attack/${randomUUID().slice(0, 8)}`,
  ...over,
});

record(
  "unlisted-payee",
  "Pay an account that isn't an approved payee",
  "payee_not_allowed",
  await call(maya, CONTRACT, "request_spend", spend({ payee: "not-a-payee.testnet" })),
);
record(
  "same-work",
  "Pay the same person for work already paid",
  "duplicate_work",
  await call(
    maya,
    CONTRACT,
    "request_spend",
    spend({ payee: paid[1].payee, work_ref: paid[1].work_ref }),
  ),
);
record(
  "same-request-id",
  "Send a payment again with a used request id",
  "duplicate_request",
  await call(maya, CONTRACT, "request_spend", spend({ request_id: paid[0] })),
);
const { auto_limit, period_cap, period_spent } = (
  await view<{ spenders: [string, Record<string, string>][] }>(network, CONTRACT, "get_envelope", {
    envelope_id: BUDGET,
  })
).spenders.find(([a]) => a === LEAD)?.[1] ?? {
  auto_limit: "0",
  period_cap: "0",
  period_spent: "0",
};
const room = BigInt(period_cap ?? "0") - BigInt(period_spent ?? "0");
// Over what the lead may still spend this period, but inside the instant limit (so no other rule
// decides first).
if (room >= 0n && room + 1n <= BigInt(auto_limit ?? "0")) {
  record(
    "period-cap",
    "Spend past the lead's cap for this period",
    "over_period_cap",
    await call(maya, CONTRACT, "request_spend", spend({ amount: String(room + 1n) })),
  );
} else {
  console.log(`skipped  period cap: ${room} left this period (needs 0 to ${auto_limit} - 1)`);
}
if (pending) {
  record(
    "lead-approves",
    "The lead approves a payment (only approvers can)",
    "not_approver",
    await call(maya, CONTRACT, "approve", { request_id: pending }),
  );
}
record(
  "create-budget",
  "Create a budget without a DAO vote",
  "not_dao",
  await call(maya, CONTRACT, "create_envelope", {
    envelope: {
      name: "Not voted",
      token_id: "tusdc.earmark.testnet",
      spenders: [],
      approvers: [LEAD],
      one_approver_limit: "1",
      raise_ceiling: "1",
      payees: [],
      period_secs: "86400",
      period_cap: "1",
      pending_ttl_secs: null,
    },
  }),
);
record(
  "close-budget",
  "Close a budget and take its money without a DAO vote",
  "not_dao",
  await call(maya, CONTRACT, "close_envelope", { envelope_id: BUDGET }),
);

// A fee-free call (NEP-366) replayed: the relay sends the same signed delegate twice. The first
// spends its nonce (its inner call fails on purpose, so nothing changes); NEAR refuses the second.
const { signedDelegate } = await maya.createSignedMetaTransaction({
  receiverId: CONTRACT,
  actions: [actions.functionCall("expire", { request_id: "no-such-request" }, 30n * TGAS, 0n)],
  blockHeightTtl: 120,
});
const payload = JSON.stringify({
  signedDelegate: Buffer.from(encodeSignedDelegate(signedDelegate)).toString("base64"),
});
const relay = async () => {
  const res = await fetch(`${APP}/api/relay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
  });
  const body = (await res.json()) as {
    error?: string;
    outcome?: {
      transaction: { hash: string; signer_id: string };
      status: { Failure?: unknown };
      receipts_outcome: { outcome: { status: { Failure?: unknown } } }[];
    };
  };
  if (!body.outcome) throw new Error(`relay: ${res.status} ${body.error}`);
  return body.outcome;
};
await relay();
const replay = await relay();
const failure =
  replay.receipts_outcome.map((r) => r.outcome.status.Failure).find(Boolean) ??
  replay.status.Failure;
record(
  "replayed-delegate",
  "Replay a signed fee-free call",
  "DelegateActionInvalidNonce",
  { hash: replay.transaction.hash, ok: !failure, value: null, error: JSON.stringify(failure) },
  replay.transaction.signer_id,
);

const file = resolve(root, "fixtures/testnet-attacks.json");
writeFileSync(
  file,
  `${JSON.stringify({ network, contract: CONTRACT, at: new Date().toISOString(), attacks: out }, null, 2)}\n`,
);
console.log(`\n${out.length} refused, recorded in fixtures/testnet-attacks.json`);
