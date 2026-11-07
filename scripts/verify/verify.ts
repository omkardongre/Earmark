// `make verify`: checks the live testnet deployment with no keys and no .env. Every check is a
// public RPC read; it prints pass/fail per check and exits non-zero if any fails. A network error
// prints a FAIL line for that check and the run goes on.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { accessKeys, EXPLORER, panicMessage, txStatus, view, viewAccount } from "../lib/near.ts";

type Step = {
  step: string;
  label: string;
  expect: string;
  tx?: string;
  signer?: string;
  ok: boolean;
  error?: string;
};
type Fixture = {
  network: "testnet";
  contract: string;
  dao: string;
  token: string;
  envelope_id: string;
  /** Hash of the wasm the DAO last installed (set by `scripts/testnet/lock.ts`). */
  code_hash?: string;
  steps: Step[];
};
type Envelope = {
  name: string;
  token_id: string;
  balance: string;
  available: string;
  committed: string;
  in_flight: string;
  spent_total: string;
  request_count: string;
};
type Request = {
  tier: string;
  status: string;
  amount: string;
  payee: string;
  dao_proposal_id: string | null;
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fx = JSON.parse(readFileSync(resolve(root, "fixtures/testnet-demo.json"), "utf8")) as Fixture;
const net = fx.network;
/** NEAR the contract keeps free for storage (R19); below it new requests are refused. */
const STORAGE_RESERVE = 5n * 10n ** 23n;
let failed = 0;

function check(name: string, pass: boolean, detail = "") {
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

/** Runs one group of checks; an error becomes a FAIL line instead of a stack trace. */
async function guard(name: string, run: () => Promise<void>) {
  try {
    await run();
  } catch (e) {
    check(name, false, e instanceof Error ? e.message : String(e));
  }
}

const usdc = (v: string | bigint) => `${Number(v) / 1e6}`;
const near = (v: bigint) => `${Number(v / 10n ** 20n) / 1e4} NEAR`;

console.log(`Earmark on ${net}: contract ${fx.contract}, DAO ${fx.dao}\n`);

// 1. No admin key (R12), the code the DAO installed, and NEAR left for storage.
await guard("contract account readable", async () => {
  const keys = await accessKeys(net, fx.contract);
  const fullKeys = keys.filter((k) => k.access_key.permission === "FullAccess");
  check("contract has no full-access key", fullKeys.length === 0, `${keys.length} keys in total`);
  const account = await viewAccount(net, fx.contract);
  if (fx.code_hash) {
    check(
      "code is the version the DAO installed",
      account.code_hash === fx.code_hash,
      account.code_hash,
    );
  } else {
    console.log(`      code hash ${account.code_hash}`);
  }
  const free = BigInt(account.amount) - BigInt(account.storage_usage) * 10n ** 19n;
  check("contract has NEAR free for new requests", free >= STORAGE_RESERVE, `${near(free)} free`);
});

// 2. The DAO is the only owner.
await guard("contract config readable", async () => {
  const config = await view<{ dao_id: string; token_ids: string[] }>(
    net,
    fx.contract,
    "get_config",
  );
  check("contract owner is the DAO", config.dao_id === fx.dao, config.dao_id);
  check(
    "budget token is allowed",
    config.token_ids.includes(fx.token),
    config.token_ids.join(", "),
  );
  const policy = await view<{ proposal_bond: string }>(net, fx.dao, "get_policy");
  check(
    "DAO policy is readable",
    typeof policy.proposal_bond === "string",
    `bond ${Number(policy.proposal_bond) / 1e24} NEAR`,
  );
});

// 3. Budget numbers add up (R4), and 4. request history: totals and DAO proposals.
await guard("budget readable", async () => {
  const env = await view<Envelope>(net, fx.contract, "get_envelope", {
    envelope_id: fx.envelope_id,
  });
  const [bal, avail, committed, inFlight] = [
    env.balance,
    env.available,
    env.committed,
    env.in_flight,
  ].map(BigInt);
  check(
    "balance = available + committed + in flight",
    bal === (avail ?? 0n) + (committed ?? 0n) + (inFlight ?? 0n),
    `${usdc(env.balance)} = ${usdc(env.available)} + ${usdc(env.committed)} + ${usdc(env.in_flight)} ${env.name}`,
  );
  const tokenBalance = await view<string>(net, fx.token, "ft_balance_of", {
    account_id: fx.contract,
  });
  check(
    "contract holds at least the budget balance",
    BigInt(tokenBalance) >= (bal ?? 0n),
    `${usdc(tokenBalance)} tUSDC held`,
  );

  const requests: [string, Request][] = [];
  for (let from = 0; ; from += 100) {
    const page = await view<[string, Request][]>(net, fx.contract, "list_requests", {
      envelope_id: fx.envelope_id,
      from_index: String(from),
      limit: 100,
    });
    requests.push(...page);
    if (page.length < 100) break;
  }
  check(
    "request history is complete",
    requests.length === Number(env.request_count),
    `${requests.length} requests`,
  );
  const paidTotal = requests
    .filter(([, r]) => r.status === "paid")
    .reduce((s, [, r]) => s + BigInt(r.amount), 0n);
  check(
    "paid requests add up to spent total",
    paidTotal === BigInt(env.spent_total),
    `${usdc(paidTotal)} paid`,
  );
  // A removed proposal is gone from the DAO, so only open and paid ones can be looked up.
  const escalated = requests.filter(
    ([, r]) => r.tier === "escalate" && (r.status === "escalated" || r.status === "paid_by_dao"),
  );
  for (const [id, r] of escalated) {
    await guard(`escalated ${id} readable`, async () => {
      const p = await view<{
        description: string;
        kind: { Transfer?: { receiver_id: string; amount: string } };
      }>(net, fx.dao, "get_proposal", { id: Number(r.dao_proposal_id) });
      const t = p.kind.Transfer;
      check(
        `escalated ${id} is DAO proposal ${r.dao_proposal_id}`,
        p.description.includes(id) && t?.receiver_id === r.payee && t?.amount === r.amount,
        `${usdc(r.amount)} to ${r.payee}, ${r.status}`,
      );
    });
  }
});

// 5. Every recorded demo transaction happened on-chain with the recorded outcome.
console.log("");
for (const s of fx.steps) {
  if (!s.tx || !s.signer) continue;
  const { tx, signer } = s;
  await guard(`${s.label} -> ${s.expect}`, async () => {
    const t = await txStatus(net, tx, signer);
    const failure =
      t.receipts_outcome.map((r) => r.outcome.status.Failure).find(Boolean) ?? t.status.Failure;
    const ok = !failure;
    const pass = ok === s.ok && (ok || panicMessage(failure) === s.error);
    check(`${s.label} -> ${s.expect}`, pass, `${EXPLORER[net]}/txns/${tx}`);
  });
}

console.log(`\n${failed === 0 ? "All checks passed." : `${failed} check(s) failed.`}`);
process.exit(failed === 0 ? 0 : 1);
