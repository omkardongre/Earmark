// `make verify` (testnet) and `make verify NET=mainnet`: checks the live deployment with no keys
// and no .env. Every check is a public RPC read. Each line is PASS, FAIL or WARN (true but worth
// knowing, e.g. one person can pass votes alone; not a failure). The exit code is the number of
// failed checks. A network error prints a FAIL line for that check and the run goes on.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type FactoryInfo,
  moneyRules,
  type Policy,
  ruleText,
} from "../../apps/web/src/lib/governance.ts";
import {
  accessKeys,
  EXPLORER,
  type Network,
  panicMessage,
  txStatus,
  view,
  viewAccount,
} from "../lib/near.ts";

type Step = {
  step: string;
  label: string;
  expect: string;
  tx?: string;
  signer?: string;
  ok: boolean;
  error?: string;
  /** Contract events (NEP-297, standard "earmark") the transaction must have logged. */
  events?: string[];
};
type Fixture = {
  network: Network;
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
const arg = process.argv.indexOf("--network");
const net = (arg > 0 ? process.argv[arg + 1] : process.env.NET || "testnet") as Network;
if (net !== "testnet" && net !== "mainnet") {
  console.error("usage: verify.ts [--network testnet|mainnet]");
  process.exit(2);
}
const FIXTURE: Record<Network, string> = {
  testnet: "fixtures/testnet-demo.json",
  mainnet: "fixtures/mainnet.json",
};
const fx = JSON.parse(readFileSync(resolve(root, FIXTURE[net]), "utf8")) as Fixture;
/** NEAR the contract keeps free for storage (R19); below it new requests are refused. */
const STORAGE_RESERVE = 5n * 10n ** 23n;
let failed = 0;
let warned = 0;

function check(name: string, pass: boolean, detail = "") {
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
/** True but worth knowing (a design choice of the DAO, not a broken promise). Not a failure. */
function note(name: string, pass: boolean, detail: string) {
  if (pass) return check(name, true, detail);
  warned++;
  console.log(`WARN  ${name}  (${detail})`);
}

/** Runs one group of checks; an error becomes a FAIL line instead of a stack trace. */
async function guard(name: string, run: () => Promise<void>) {
  try {
    await run();
  } catch (e) {
    check(name, false, e instanceof Error ? e.message : String(e));
  }
}

const meta = await view<{ symbol: string; decimals: number }>(net, fx.token, "ft_metadata").catch(
  () => ({ symbol: "tokens", decimals: 6 }),
);
const usdc = (v: string | bigint) => `${Number(v) / 10 ** meta.decimals}`;
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

// 2b. Who controls the DAO that owns Earmark: its code, and how many members a vote needs.
await guard("DAO readable", async () => {
  const [account, factory, policy] = await Promise.all([
    viewAccount(net, fx.dao),
    view<FactoryInfo>(net, fx.dao, "get_factory_info"),
    view<Policy>(net, fx.dao, "get_policy"),
  ]);
  const code = account.global_contract_hash ?? account.code_hash;
  const published = await view<[string, unknown][]>(
    net,
    factory.factory_id,
    "get_contracts_metadata",
  ).catch(() => [] as [string, unknown][]);
  check(
    "DAO runs Sputnik code its factory published",
    published.some(([h]) => h === code),
    `${code.slice(0, 8)}… from ${factory.factory_id}`,
  );
  note(
    "factory can't replace the DAO's code without a vote",
    !factory.auto_update,
    factory.auto_update
      ? `auto_update is on: ${factory.factory_id}'s key holders can install new DAO code. Fix: one FactoryInfoUpdate vote with auto_update false`
      : "auto_update is off",
  );
  const r = moneyRules(policy);
  for (const [what, rule] of [
    ["a payout", r.payouts],
    ["a budget change", r.calls],
    ["new Earmark code", r.code],
  ] as const) {
    if (!rule) {
      check(`DAO can approve ${what}`, false, "no named role can vote on it");
      continue;
    }
    note(
      `${what} needs more than one DAO member`,
      rule.needed > 1,
      `${ruleText(rule)} in ${rule.role}${rule.needed === 1 ? `: ${rule.members.join(", ")} can pass it alone` : ""}`,
    );
  }
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
    `${usdc(tokenBalance)} ${meta.symbol} held`,
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
        kind: { Transfer?: { receiver_id: string; amount: string; msg?: string | null } };
      }>(net, fx.dao, "get_proposal", { id: Number(r.dao_proposal_id) });
      const t = p.kind.Transfer;
      // R22: the DAO sends the money to the contract with the request id, and the contract pays
      // the payee. Proposals filed before R22 paid the payee directly.
      const toContract =
        t?.receiver_id === fx.contract && t.msg === JSON.stringify({ request_id: id });
      check(
        `escalated ${id} is DAO proposal ${r.dao_proposal_id}`,
        p.description.includes(id) &&
          (toContract || t?.receiver_id === r.payee) &&
          t?.amount === r.amount,
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
    const logged = new Set(
      t.receipts_outcome
        .flatMap((r) => r.outcome.logs)
        .filter((l) => l.startsWith("EVENT_JSON:"))
        .map((l) => JSON.parse(l.slice(11)) as { standard: string; event: string })
        .filter((e) => e.standard === "earmark")
        .map((e) => e.event),
    );
    const events = (s.events ?? []).every((e) => logged.has(e));
    const pass = ok === s.ok && (ok || panicMessage(failure) === s.error) && events;
    check(`${s.label} -> ${s.expect}`, pass, `${EXPLORER[net]}/txns/${tx}`);
  });
}

// 6. Attacks the contract (or NEAR) refused, recorded by `make attacks`: each must still read as
// refused for the recorded reason. Anyone can open the tx links.
const attacksFile = resolve(root, `fixtures/${net}-attacks.json`);
if (existsSync(attacksFile)) {
  const { attacks } = JSON.parse(readFileSync(attacksFile, "utf8")) as {
    attacks: { label: string; expect: string; tx: string; signer: string }[];
  };
  console.log("");
  let refused = 0;
  for (const a of attacks) {
    await guard(`refused: ${a.label}`, async () => {
      const t = await txStatus(net, a.tx, a.signer);
      const failure =
        t.receipts_outcome.map((r) => r.outcome.status.Failure).find(Boolean) ?? t.status.Failure;
      const pass = Boolean(failure) && JSON.stringify(failure).includes(a.expect);
      if (pass) refused++;
      check(`refused: ${a.label} (${a.expect})`, pass, `${EXPLORER[net]}/txns/${a.tx}`);
    });
  }
  console.log(`      ${refused} of ${attacks.length} attacks refused on chain`);
}

const warnings = warned ? ` ${warned} warning(s): true facts, not failures.` : "";
console.log(`\n${failed === 0 ? "All checks passed." : `${failed} check(s) failed.`}${warnings}`);
process.exit(Math.min(failed, 100));
