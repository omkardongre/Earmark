// The "Try it" sandbox: a separate Earmark contract with one small budget that visitors drive
// from the web app with no wallet. The server signs with two function-call keys: the demo lead's
// key can only call `request_spend`, the demo council member's key only `approve` and `expire`,
// both only on the sandbox contract. Testnet only; full-access keys stay in the CLI keychain.
//   setup    accounts, contract (no keys left), budget owned by the demo DAO, keys, first payout
//   scenes   the two small extra budgets: "race" (10 tUSDC, nothing paid at once, 60 s approval
//            window) and "paused" (the lead is paused there), so the main budget stays open
//   limits   moves budget 0 to the planned limits (5 paid at once, 50 with one approval): a DAO
//            vote queues the change, the contract's loosening delay runs, then run it again
//   refill   tops up the budget (DAO vote), the contract's storage NEAR and the signers' gas
//   env      writes the two keys to apps/web/.env.local (gitignored) for local runs
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { actions, KeyPair, PublicKey } from "near-api-js";
import {
  accessKeys,
  accountExists,
  call,
  keychainAccount,
  NEAR,
  type Network,
  view,
  viewAccount,
} from "../lib/near.ts";
import { daoDo, ensureAccount, functionCallKind } from "../lib/testnet.ts";

const network: Network = "testnet";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const demo = JSON.parse(readFileSync(resolve(root, "fixtures/testnet-demo.json"), "utf8")) as {
  dao: string;
  token: string;
  admins: string[];
};
const OWNER = process.env.OWNER ?? "earmark.testnet";
const CONTRACT = process.env.TRY_CONTRACT ?? `try.${OWNER}`;
const DAO = demo.dao;
const TOKEN = demo.token;
const [PROPOSER = OWNER] = demo.admins;
const VOTERS = demo.admins;
const LEAD = `try-lead.${OWNER}`;
const COUNCIL = `try-council.${OWNER}`;
const PAYEES = [`try-writer.${OWNER}`, `try-designer.${OWNER}`];
/** Paid once at setup, so "pay the same work again" is refused. */
const PAID_WORK = "https://try.earmark.example/already-paid";
const WASM = resolve(root, "target/near/earmark/earmark.wasm");
const FIXTURE = resolve(root, "fixtures/testnet-try.json");
const KEYS = `${homedir()}/.near-credentials/${network}/earmark-try-keys.json`;
const usdc = (n: number) => String(BigInt(Math.round(n * 1e6)));
const TGAS = 1_000_000_000_000n;
/** Caps the gas a key can spend; the account's balance is the real limit and refill tops it up. */
const ALLOWANCE = NEAR("10");
/** Planned limits of the main budget: "pay 5" pays at once, "ask 40" needs one approval. */
const AUTO_LIMIT = usdc(5);
const ONE_APPROVER_LIMIT = usdc(50);
/** The race budget's funds; each race reserves part of what is left, then it expires. */
const RACE_FUNDS = usdc(10);
const BUDGET_NAMES = { race: "Try it: race", paused: "Try it: paused" } as const;

type Keys = Record<"lead" | "council", { account: string; private_key: string }>;

async function setup() {
  for (const id of [LEAD, COUNCIL]) await ensureAccount(OWNER, id, "1.5");
  for (const id of PAYEES) await ensureAccount(OWNER, id, "0.05");

  if (!(await accountExists(network, CONTRACT))) {
    await ensureAccount(OWNER, CONTRACT, "6.5");
    await keychainAccount(network, CONTRACT).signAndSendTransaction({
      receiverId: CONTRACT,
      actions: [
        actions.deployContract(readFileSync(WASM)),
        actions.functionCall("new", { dao_id: DAO, token_ids: [TOKEN] }, 30n * TGAS, 0n),
      ],
      waitUntil: "FINAL",
    });
    console.log(`deployed ${CONTRACT}`);
  }
  const full = (await accessKeys(network, CONTRACT)).filter(
    (k) => k.access_key.permission === "FullAccess",
  );
  if (full.length > 0) {
    await keychainAccount(network, CONTRACT).signAndSendTransaction({
      receiverId: CONTRACT,
      actions: full.map((k) => actions.deleteKey(PublicKey.fromString(k.public_key))),
      waitUntil: "FINAL",
    });
    console.log(`deleted ${full.length} key(s) of ${CONTRACT}`);
  }

  const bounds = await view<{ min: string }>(network, TOKEN, "storage_balance_bounds");
  for (const id of [CONTRACT, ...PAYEES]) {
    if (!(await view<unknown>(network, TOKEN, "storage_balance_of", { account_id: id }))) {
      await call(
        keychainAccount(network, OWNER),
        TOKEN,
        "storage_deposit",
        { account_id: id, registration_only: true },
        { gasTgas: 30, deposit: BigInt(bounds.min) },
      );
    }
  }

  const config = await view<{ envelope_count: string }>(network, CONTRACT, "get_config");
  if (config.envelope_count === "0") {
    const envelope = {
      name: "Try it",
      token_id: TOKEN,
      spenders: [{ account_id: LEAD, auto_limit: AUTO_LIMIT, period_cap: usdc(5000) }],
      approvers: [COUNCIL],
      one_approver_limit: ONE_APPROVER_LIMIT,
      raise_ceiling: usdc(5),
      payees: PAYEES,
      // Short period and approval window, so many visitors can use it.
      period_secs: "3600",
      period_cap: usdc(10000),
      pending_ttl_secs: "600",
    };
    await daoDo(
      DAO,
      PROPOSER,
      VOTERS,
      '* Title: Create Earmark sandbox budget "Try it" <br>* Notes: public demo, no wallet needed',
      functionCallKind(CONTRACT, "create_envelope", { envelope }, NEAR("0.1").toString()),
    );
    console.log('created budget 0 "Try it"');
  }

  const keys = await ensureKeys();
  await refill();

  // One paid item, so the "same work again" scene has something to repeat.
  const signer = keychainAccount(network, LEAD);
  const check = await view<{ blocked: string | null }>(network, CONTRACT, "check_spend", {
    envelope_id: "0",
    spender: LEAD,
    request_id: "setup-paid-work",
    payee: PAYEES[0],
    amount: usdc(1),
    work_ref: PAID_WORK,
  });
  if (check.blocked === null) {
    const r = await call(
      signer,
      CONTRACT,
      "request_spend",
      {
        envelope_id: "0",
        request_id: "setup-paid-work",
        payee: PAYEES[0],
        amount: usdc(1),
        memo: "First article",
        work_ref: PAID_WORK,
      },
      { gasTgas: 80 },
    );
    console.log(`paid the first item: ${r.ok ? String(r.value) : r.error}`);
  }

  writeFixture({
    network,
    contract: CONTRACT,
    dao: DAO,
    token: TOKEN,
    envelope_id: "0",
    lead: LEAD,
    council: COUNCIL,
    payees: PAYEES,
    paid_work: PAID_WORK,
    lead_key: keys.leadPublic,
    council_key: keys.councilPublic,
  });
  await scenes();
}

function writeFixture(fields: object) {
  const old = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, "utf8")) : {};
  writeFileSync(FIXTURE, `${JSON.stringify({ ...old, ...fields }, null, 2)}\n`);
  console.log(`wrote ${FIXTURE}`);
}

type Budget = {
  id: string;
  name: string;
  available: string;
  one_approver_limit: string;
  raise_ceiling: string;
  spenders: [string, { auto_limit: string; paused: boolean }][];
};

/** The id of the budget named `name`, created by a DAO vote if missing. */
async function ensureBudget(name: string, envelope: object): Promise<Budget> {
  const find = async () =>
    (await view<Budget[]>(network, CONTRACT, "list_envelopes", {})).find((b) => b.name === name);
  const found = await find();
  if (found) return found;
  const r = await daoDo(
    DAO,
    PROPOSER,
    VOTERS,
    `* Title: Create Earmark sandbox budget "${name}" <br>* Notes: public demo, no wallet needed`,
    functionCallKind(CONTRACT, "create_envelope", { envelope }, NEAR("0.1").toString()),
  );
  const created = await find();
  if (!created) throw new Error(`create "${name}" failed: ${r.error ?? r.hash}`);
  console.log(
    `created budget ${created.id} "${name}" (DAO proposal ${r.proposalId}, tx ${r.hash})`,
  );
  return created;
}

/** The race and paused budgets. Both use the lead's existing key, so no new secrets. */
async function scenes() {
  const common = {
    token_id: TOKEN,
    approvers: [COUNCIL],
    raise_ceiling: "0",
    payees: [PAYEES[0]],
    period_secs: "3600",
    period_cap: usdc(10000),
  };
  // Nothing is paid at once here, so a request only reserves funds; the server expires the
  // reservations after the 60 s window and nobody can approve them (the app approves only
  // budget 0's requests), so the 10 tUSDC stay in the budget.
  const race = await ensureBudget(BUDGET_NAMES.race, {
    ...common,
    name: BUDGET_NAMES.race,
    spenders: [{ account_id: LEAD, auto_limit: "0", period_cap: usdc(10000) }],
    one_approver_limit: RACE_FUNDS,
    pending_ttl_secs: "60",
  });
  const paused = await ensureBudget(BUDGET_NAMES.paused, {
    ...common,
    name: BUDGET_NAMES.paused,
    spenders: [{ account_id: LEAD, auto_limit: "0", period_cap: usdc(10000) }],
    one_approver_limit: usdc(10),
  });

  const funded = await view<{ balance: string }>(network, CONTRACT, "get_envelope", {
    envelope_id: race.id,
  });
  if (BigInt(funded.balance) < BigInt(RACE_FUNDS)) {
    const missing = String(BigInt(RACE_FUNDS) - BigInt(funded.balance));
    const owner = keychainAccount(network, OWNER);
    await call(owner, TOKEN, "mint", { account_id: DAO, amount: missing }, { gasTgas: 30 });
    const r = await daoDo(
      DAO,
      PROPOSER,
      VOTERS,
      `* Title: Fund sandbox budget "${BUDGET_NAMES.race}" <br>* Notes: ${Number(missing) / 1e6} tUSDC`,
      {
        Transfer: {
          token_id: TOKEN,
          receiver_id: CONTRACT,
          amount: missing,
          msg: JSON.stringify({ envelope_id: race.id }),
        },
      },
    );
    console.log(`funded budget ${race.id} with ${Number(missing) / 1e6} tUSDC (tx ${r.hash})`);
  }

  // Pausing tightens, so the council member's own (full-access, keychain) key does it at once.
  if (!paused.spenders.find(([id]) => id === LEAD)?.[1].paused) {
    const r = await call(
      keychainAccount(network, COUNCIL),
      CONTRACT,
      "pause",
      { envelope_id: paused.id, spender: LEAD },
      { gasTgas: 30 },
    );
    if (!r.ok) throw new Error(`pause: ${r.error}`);
    console.log(`paused ${LEAD} in budget ${paused.id} (tx ${r.hash})`);
  }
  writeFixture({ race_envelope_id: race.id, paused_envelope_id: paused.id });
}

type Queued = { envelope_id: string; change: object; effective_at_ns: string };

/** Budget 0 to the planned limits. Loosening waits for the contract's delay, so run it twice. */
async function limits() {
  const b = await view<Budget>(network, CONTRACT, "get_envelope", { envelope_id: "0" });
  const queued = await view<[string, Queued][]>(network, CONTRACT, "list_queued", {
    envelope_id: "0",
  });
  const wanted: object[] = [];
  if (b.one_approver_limit !== ONE_APPROVER_LIMIT)
    wanted.push({ one_approver_limit: { amount: ONE_APPROVER_LIMIT } });
  if (BigInt(b.raise_ceiling) < BigInt(AUTO_LIMIT))
    wanted.push({ raise_ceiling: { amount: AUTO_LIMIT } });
  const lead = b.spenders.find(([id]) => id === LEAD)?.[1];
  if (lead && lead.auto_limit !== AUTO_LIMIT)
    wanted.push({ spender_auto_limit: { spender: LEAD, amount: AUTO_LIMIT } });
  if (wanted.length === 0) {
    console.log("budget 0 limits are as planned: 5 paid at once, 50 with one approval");
    return;
  }

  const same = (a: object, c: object) => JSON.stringify(a) === JSON.stringify(c);
  const now = BigInt(Date.now()) * 1_000_000n;
  const toQueue: object[] = [];
  for (const change of wanted) {
    const q = queued.find(([, c]) => same(c.change, change));
    if (!q) {
      toQueue.push(change);
      continue;
    }
    const [id, c] = q;
    if (BigInt(c.effective_at_ns) > now) {
      const at = new Date(Number(BigInt(c.effective_at_ns) / 1_000_000n)).toISOString();
      console.log(`change ${id} ${JSON.stringify(change)} is queued; run again after ${at}`);
      continue;
    }
    // Anyone may apply a queued change once its delay has run.
    const r = await call(
      keychainAccount(network, OWNER),
      CONTRACT,
      "apply_change",
      { change_id: id },
      { gasTgas: 30 },
    );
    console.log(`apply_change ${id}: ${r.ok ? String(r.value) : r.error} (tx ${r.hash})`);
  }
  if (toQueue.length > 0) {
    const r = await daoDo(
      DAO,
      PROPOSER,
      VOTERS,
      '* Title: Sandbox budget "Try it": 50 tUSDC with one approval <br>* Notes: public demo',
      functionCallKind(CONTRACT, "update_envelope", { envelope_id: "0", changes: toQueue }),
    );
    if (!r.ok) throw new Error(`update_envelope: ${r.error}`);
    const delay = (await view<{ loosen_delay_secs: string }>(network, CONTRACT, "get_config"))
      .loosen_delay_secs;
    console.log(
      `queued ${JSON.stringify(toQueue)} (DAO proposal ${r.proposalId}, tx ${r.hash}); ` +
        `run "try.ts limits" again in ${Number(delay) / 3600} h`,
    );
  }
}

/** Adds the two function-call keys once; the private parts go to the keychain file only. */
async function ensureKeys() {
  const stored: Keys | null = existsSync(KEYS) ? JSON.parse(readFileSync(KEYS, "utf8")) : null;
  const out = { leadPublic: "", councilPublic: "" };
  const make = async (account: string, methods: string[]) => {
    const existing = stored?.[account === LEAD ? "lead" : "council"];
    if (existing) {
      const pub = KeyPair.fromString(existing.private_key as never)
        .getPublicKey()
        .toString();
      if ((await accessKeys(network, account)).some((k) => k.public_key === pub)) return existing;
    }
    const kp = KeyPair.fromRandom("ed25519");
    await keychainAccount(network, account).signAndSendTransaction({
      receiverId: account,
      actions: [actions.addFunctionCallAccessKey(kp.getPublicKey(), CONTRACT, methods, ALLOWANCE)],
      waitUntil: "FINAL",
    });
    console.log(`added ${methods.join("/")} key to ${account}`);
    return { account, private_key: kp.toString() };
  };
  const keys: Keys = {
    lead: await make(LEAD, ["request_spend"]),
    council: await make(COUNCIL, ["approve", "expire"]),
  };
  writeFileSync(KEYS, JSON.stringify(keys), { mode: 0o600 });
  const pub = (k: { private_key: string }) =>
    KeyPair.fromString(k.private_key as never)
      .getPublicKey()
      .toString();
  out.leadPublic = pub(keys.lead);
  out.councilPublic = pub(keys.council);
  return out;
}

async function refill() {
  const env = await view<{ available: string }>(network, CONTRACT, "get_envelope", {
    envelope_id: "0",
  });
  if (BigInt(env.available) < BigInt(usdc(100))) {
    const owner = keychainAccount(network, OWNER);
    await call(owner, TOKEN, "mint", { account_id: DAO, amount: usdc(500) }, { gasTgas: 30 });
    await daoDo(
      DAO,
      PROPOSER,
      VOTERS,
      '* Title: Refill sandbox budget "Try it" <br>* Notes: 500 tUSDC',
      {
        Transfer: {
          token_id: TOKEN,
          receiver_id: CONTRACT,
          amount: usdc(500),
          msg: JSON.stringify({ envelope_id: "0" }),
        },
      },
    );
    console.log("funded the sandbox with 500 tUSDC");
  }
  // NEAR: storage for new requests on the contract, gas for the two signers.
  const topUp = async (id: string, min: string, add: string) => {
    const a = await viewAccount(network, id);
    const free = BigInt(a.amount) - BigInt(a.storage_usage) * 10n ** 19n;
    if (free < NEAR(min)) {
      await keychainAccount(network, OWNER).signAndSendTransaction({
        receiverId: id,
        actions: [actions.transfer(NEAR(add))],
        waitUntil: "FINAL",
      });
      console.log(`sent ${add} NEAR to ${id}`);
    }
  };
  await topUp(CONTRACT, "1.5", "2");
  await topUp(LEAD, "0.5", "1");
  await topUp(COUNCIL, "0.5", "1");
}

/** Writes the keys for a local `make web` (the hosted app reads them from Secret Manager). */
function env() {
  const keys = JSON.parse(readFileSync(KEYS, "utf8")) as Keys;
  const file = resolve(root, "apps/web/.env.local");
  const old = existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l && !l.startsWith("TRY_"))
    : [];
  const lines = [
    ...old,
    `TRY_CONTRACT=${CONTRACT}`,
    `TRY_LEAD_ACCOUNT=${keys.lead.account}`,
    `TRY_LEAD_KEY=${keys.lead.private_key}`,
    `TRY_COUNCIL_ACCOUNT=${keys.council.account}`,
    `TRY_COUNCIL_KEY=${keys.council.private_key}`,
  ];
  writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
  console.log(`wrote the sandbox keys to ${file}`);
}

const phases: Record<string, () => Promise<void> | void> = { setup, scenes, limits, refill, env };
const phase = process.argv[2] ?? "";
if (!phases[phase]) {
  console.error(`usage: try.ts <${Object.keys(phases).join("|")}>`);
  process.exit(2);
}
await phases[phase]();
