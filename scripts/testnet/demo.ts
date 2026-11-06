// Seeds the testnet demo (docs/04) and records every transaction in fixtures/testnet-demo.json,
// which `make demo` replays and `make verify` checks. Testnet only; keys come from the NEAR CLI
// legacy keychain. Run the phases in order:
//   setup    accounts, contract, budget "News contributors"
//   history  alice's 3 earlier payouts (eligibility needs them to be 1 day old)
//   scenes   the demo scenes up to pause
//   raise    limit raise, ceiling and cancel (run at least 1 day after `history`)
//   close    the DAO closes the budget
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { actions, KeyPair } from "near-api-js";
import {
  accountExists,
  type CallResult,
  call,
  keychainAccount,
  NEAR,
  type Network,
  view,
} from "../lib/near.ts";

const network: Network = "testnet";
const OWNER = process.env.OWNER ?? "earmark.testnet";
const CONTRACT = process.env.CONTRACT ?? `v4.${OWNER}`;
const DAO = process.env.DAO ?? "earmark-demo.sputnikv2.testnet";
const TOKEN = process.env.TOKEN ?? `tusdc.${OWNER}`;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WASM = resolve(root, "target/near/earmark/earmark.wasm");
const FIXTURE = resolve(root, "fixtures/testnet-demo.json");

const name = (n: string) => `${n}.${OWNER}`;
const ALICE = name("alice");
const BOB = name("bob");
const COUNCIL_1 = name("council-1");
const COUNCIL_2 = name("council-2");
const WRITER_1 = name("writer-1");
const WRITER_2 = name("writer-2");
const DESIGNER = name("designer");
const UNKNOWN = name("stranger");
const usdc = (n: number) => String(BigInt(Math.round(n * 1e6)));

type Step = {
  step: string;
  label: string;
  expect: string;
  tx?: string;
  signer?: string;
  ok: boolean;
  result?: unknown;
  error?: string | undefined;
  available?: string | undefined;
};
type Fixture = {
  network: Network;
  contract: string;
  dao: string;
  token: string;
  envelope_id: string;
  accounts: Record<string, string>;
  steps: Step[];
};

function load(): Fixture {
  if (existsSync(FIXTURE)) return JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;
  return {
    network,
    contract: CONTRACT,
    dao: DAO,
    token: TOKEN,
    envelope_id: "",
    accounts: {
      alice: ALICE,
      bob: BOB,
      council_1: COUNCIL_1,
      council_2: COUNCIL_2,
      writer_1: WRITER_1,
      writer_2: WRITER_2,
      designer: DESIGNER,
    },
    steps: [],
  };
}

const fixture = load();
const save = () => {
  mkdirSync(dirname(FIXTURE), { recursive: true });
  writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
};

async function available(): Promise<string> {
  const e = await view<{ available: string }>(network, CONTRACT, "get_envelope", {
    envelope_id: fixture.envelope_id,
  });
  return (Number(e.available) / 1e6).toString();
}

/** Records a step; fails the run if the outcome isn't the expected one. */
async function record(step: string, label: string, expect: string, signer: string, r: CallResult) {
  const [kind, want] = expect.split(" ");
  const matches =
    kind === "ok"
      ? r.ok && (want === undefined || r.value === want)
      : !r.ok && (r.error ?? "").startsWith(want ?? "");
  const entry: Step = {
    step,
    label,
    expect,
    tx: r.hash,
    signer,
    ok: r.ok,
    result: r.value,
    error: r.error,
    available: fixture.envelope_id ? await available() : undefined,
  };
  fixture.steps = fixture.steps.filter((s) => s.step !== step).concat(entry);
  save();
  console.log(
    `${matches ? "ok  " : "FAIL"} ${label.padEnd(44)} -> ${r.ok ? JSON.stringify(r.value) : r.error}  ${r.hash}`,
  );
  if (!matches) throw new Error(`${step}: expected ${expect}`);
}

const as = (id: string) => keychainAccount(network, id);

async function ensureAccount(id: string, near: string) {
  if (await accountExists(network, id)) return;
  const kp = KeyPair.fromRandom("ed25519");
  const owner = as(OWNER);
  await owner.signAndSendTransaction({
    receiverId: id,
    actions: [
      actions.createAccount(),
      actions.transfer(NEAR(near)),
      actions.addFullAccessKey(kp.getPublicKey()),
    ],
    waitUntil: "FINAL",
  });
  const dir = `${homedir()}/.near-credentials/${network}`;
  writeFileSync(
    `${dir}/${id}.json`,
    JSON.stringify({
      account_id: id,
      public_key: kp.getPublicKey().toString(),
      private_key: kp.toString(),
    }),
    { mode: 0o600 },
  );
  console.log(`created ${id}`);
}

/** Files a DAO proposal as the council member and approves it. Returns the approve tx. */
async function daoDo(
  description: string,
  kind: object,
): Promise<CallResult & { proposalId: number }> {
  const owner = as(OWNER);
  const policy = await view<{ proposal_bond: string }>(network, DAO, "get_policy");
  const added = await call(
    owner,
    DAO,
    "add_proposal",
    { proposal: { description, kind } },
    {
      gasTgas: 50,
      deposit: BigInt(policy.proposal_bond),
    },
  );
  if (!added.ok) throw new Error(`add_proposal: ${added.error}`);
  const proposalId = Number(added.value);
  const stored = await view<{ kind: object }>(network, DAO, "get_proposal", { id: proposalId });
  const voted = await call(
    owner,
    DAO,
    "act_proposal",
    { id: proposalId, action: "VoteApprove", proposal: stored.kind },
    {
      gasTgas: 300,
    },
  );
  const after = await view<{ status: string }>(network, DAO, "get_proposal", { id: proposalId });
  if (after.status !== "Approved")
    throw new Error(`proposal ${proposalId}: ${after.status} ${voted.error ?? ""}`);
  return { ...voted, proposalId };
}

async function fund(step: string, amount: number) {
  const owner = as(OWNER);
  await call(owner, TOKEN, "mint", { account_id: DAO, amount: usdc(amount) }, { gasTgas: 30 });
  const r = await daoDo(`Fund Earmark budget ${fixture.envelope_id} with ${amount} tUSDC`, {
    Transfer: {
      token_id: TOKEN,
      receiver_id: CONTRACT,
      amount: usdc(amount),
      msg: JSON.stringify({ envelope_id: fixture.envelope_id }),
    },
  });
  await record(step, `DAO funds the budget with ${amount}`, "ok", OWNER, r);
}

let seq = 0;
const runId = Date.now().toString(36);
const rid = (tag: string) => `${runId}-${tag}-${++seq}`;

function spend(
  spender: string,
  payee: string,
  amount: number,
  work: string,
  requestId = rid("req"),
) {
  return call(
    as(spender),
    CONTRACT,
    "request_spend",
    {
      envelope_id: fixture.envelope_id,
      request_id: requestId,
      payee,
      amount: usdc(amount),
      memo: "",
      work_ref: work,
    },
    { gasTgas: 200 },
  );
}

async function setup() {
  for (const id of [ALICE, BOB, COUNCIL_1, COUNCIL_2]) await ensureAccount(id, "1");
  for (const id of [WRITER_1, WRITER_2, DESIGNER]) await ensureAccount(id, "0.2");

  if (!(await accountExists(network, CONTRACT))) {
    await ensureAccount(CONTRACT, "6");
    const contract = as(CONTRACT);
    await contract.signAndSendTransaction({
      receiverId: CONTRACT,
      actions: [
        actions.deployContract(readFileSync(WASM)),
        actions.functionCall(
          "new",
          {
            dao_id: DAO,
            token_ids: [TOKEN],
            loosen_delay_secs: "120",
            // Demo eligibility: 3 paid requests over 1 day, no for-cause reject in 30 days.
            eligibility: {
              min_paid_count: 3,
              min_history_secs: "86400",
              cause_cooldown_secs: "2592000",
            },
          },
          30n * 1_000_000_000_000n,
          0n,
        ),
      ],
      waitUntil: "FINAL",
    });
    console.log(`deployed ${CONTRACT}`);
  }

  const owner = as(OWNER);
  const bounds = await view<{ min: string }>(network, TOKEN, "storage_balance_bounds");
  for (const id of [CONTRACT, DAO, WRITER_1, WRITER_2, DESIGNER]) {
    const bal = await view<unknown>(network, TOKEN, "storage_balance_of", { account_id: id });
    if (!bal) {
      await call(
        owner,
        TOKEN,
        "storage_deposit",
        { account_id: id, registration_only: true },
        {
          gasTgas: 30,
          deposit: BigInt(bounds.min),
        },
      );
    }
  }

  const envelope = {
    name: "News contributors",
    token_id: TOKEN,
    spenders: [
      { account_id: ALICE, auto_limit: usdc(10), period_cap: usdc(200) },
      { account_id: BOB, auto_limit: usdc(10), period_cap: usdc(200) },
    ],
    approvers: [COUNCIL_1, COUNCIL_2],
    one_approver_limit: usdc(50),
    raise_ceiling: usdc(25),
    payees: [WRITER_1, WRITER_2, DESIGNER],
    period_secs: "2592000",
    period_cap: usdc(500),
  };
  const before = await view<{ envelope_count: string }>(network, CONTRACT, "get_config");
  const r = await daoDo("Create Earmark budget: News contributors", {
    FunctionCall: {
      receiver_id: CONTRACT,
      actions: [
        {
          method_name: "create_envelope",
          args: Buffer.from(JSON.stringify({ envelope })).toString("base64"),
          deposit: NEAR("0.1").toString(),
          gas: "50000000000000",
        },
      ],
    },
  });
  fixture.envelope_id = before.envelope_count;
  save();
  await record("create", 'DAO creates budget "News contributors"', "ok", OWNER, r);
}

async function history() {
  await fund("history-fund", 6);
  await record(
    "history-1",
    "alice pays writer-1 2 (earlier work)",
    "ok",
    ALICE,
    await spend(ALICE, WRITER_1, 2, "https://news.example/history-1"),
  );
  await record(
    "history-2",
    "alice pays writer-2 2 (earlier work)",
    "ok",
    ALICE,
    await spend(ALICE, WRITER_2, 2, "https://news.example/history-2"),
  );
  await record(
    "history-3",
    "alice pays designer 2 (earlier work)",
    "ok",
    ALICE,
    await spend(ALICE, DESIGNER, 2, "https://news.example/history-3"),
  );
}

async function scenes() {
  await fund("fund", 100);
  const article = `https://news.example/${runId}/article-1`;
  await record(
    "auto",
    "alice pays writer-1 5",
    "ok paid",
    ALICE,
    await spend(ALICE, WRITER_1, 5, article),
  );

  const pendingId = rid("design");
  await record(
    "one-approval",
    "alice requests 40 for designer",
    "ok pending_approval",
    ALICE,
    await spend(ALICE, DESIGNER, 40, `https://news.example/${runId}/cover`, pendingId),
  );
  await record(
    "approve",
    "council-1 approves the 40",
    "ok paid",
    COUNCIL_1,
    await call(as(COUNCIL_1), CONTRACT, "approve", { request_id: pendingId }, { gasTgas: 100 }),
  );

  await record(
    "escalate",
    "alice requests 300 for writer-2",
    "ok escalated",
    ALICE,
    await spend(ALICE, WRITER_2, 300, `https://news.example/${runId}/series`),
  );

  const [a, b] = await Promise.all([
    spend(ALICE, WRITER_1, 30, `https://news.example/${runId}/race-a`),
    spend(BOB, WRITER_2, 30, `https://news.example/${runId}/race-b`),
  ]);
  const [first, second] = a.ok ? [a, b] : [b, a];
  await record(
    "race-first",
    "race: first 30 of 55 reserves",
    "ok pending_approval",
    first === a ? ALICE : BOB,
    first,
  );
  await record(
    "race-second",
    "race: second 30 is refused",
    "rejected over_available",
    first === a ? BOB : ALICE,
    second,
  );
  await record(
    "control",
    "control: 30 with 25 left",
    "rejected over_available",
    BOB,
    await spend(BOB, WRITER_2, 30, `https://news.example/${runId}/control`),
  );

  await record(
    "duplicate-work",
    "alice pays writer-1 again, same link",
    "rejected duplicate_work",
    ALICE,
    await spend(ALICE, WRITER_1, 5, article),
  );
  await record(
    "unknown-payee",
    "alice pays an unknown account",
    "rejected payee_not_allowed",
    ALICE,
    await spend(ALICE, UNKNOWN, 5, `https://news.example/${runId}/x`),
  );
  const repeated = rid("retry");
  await spend(ALICE, WRITER_2, 1, `https://news.example/${runId}/retry`, repeated);
  await record(
    "duplicate-request",
    "network retry, same request id",
    "rejected duplicate_request",
    ALICE,
    await spend(ALICE, WRITER_2, 1, `https://news.example/${runId}/retry-2`, repeated),
  );

  await record(
    "pause",
    "council-2 pauses bob",
    "ok",
    COUNCIL_2,
    await call(
      as(COUNCIL_2),
      CONTRACT,
      "pause",
      { envelope_id: fixture.envelope_id, spender: BOB },
      { gasTgas: 30 },
    ),
  );
  await record(
    "paused",
    "bob pays writer-1 5",
    "rejected paused",
    BOB,
    await spend(BOB, WRITER_1, 5, `https://news.example/${runId}/after-pause`),
  );
}

async function raise() {
  const eligible = await view<boolean>(network, CONTRACT, "eligible", { account_id: ALICE });
  if (!eligible) throw new Error("alice isn't eligible yet: run `raise` 1 day after `history`");
  const c1 = as(COUNCIL_1);
  const env = fixture.envelope_id;
  const queued = await call(
    c1,
    CONTRACT,
    "raise_limit",
    { envelope_id: env, spender: ALICE, new_limit: usdc(20) },
    { gasTgas: 30 },
  );
  await record("raise", "council-1 raises alice to 20", "ok", COUNCIL_1, queued);
  const changeId = String(queued.value);
  await record(
    "apply-early",
    "apply the raise before the delay",
    "rejected not_yet",
    OWNER,
    await call(as(OWNER), CONTRACT, "apply_change", { change_id: changeId }, { gasTgas: 30 }),
  );
  await record(
    "over-ceiling",
    "council-1 raises alice to 30",
    "rejected above_ceiling",
    COUNCIL_1,
    await call(
      c1,
      CONTRACT,
      "raise_limit",
      { envelope_id: env, spender: ALICE, new_limit: usdc(30) },
      { gasTgas: 30 },
    ),
  );
  console.log("waiting out the 2-minute delay...");
  await new Promise((r) => setTimeout(r, 125_000));
  await record(
    "apply",
    "apply the raise after the delay",
    "ok",
    OWNER,
    await call(as(OWNER), CONTRACT, "apply_change", { change_id: changeId }, { gasTgas: 30 }),
  );

  const again = await call(
    c1,
    CONTRACT,
    "raise_limit",
    { envelope_id: env, spender: ALICE, new_limit: usdc(25) },
    { gasTgas: 30 },
  );
  await record("raise-2", "council-1 queues alice to 25", "ok", COUNCIL_1, again);
  await record(
    "cancel",
    "council-2 cancels it",
    "ok",
    COUNCIL_2,
    await call(
      as(COUNCIL_2),
      CONTRACT,
      "cancel_change",
      { change_id: String(again.value) },
      { gasTgas: 30 },
    ),
  );
  await record(
    "apply-cancelled",
    "apply the cancelled raise",
    "rejected not_queued",
    OWNER,
    await call(
      as(OWNER),
      CONTRACT,
      "apply_change",
      { change_id: String(again.value) },
      { gasTgas: 30 },
    ),
  );
}

async function close() {
  const r = await daoDo(`Close Earmark budget ${fixture.envelope_id}`, {
    FunctionCall: {
      receiver_id: CONTRACT,
      actions: [
        {
          method_name: "close_envelope",
          args: Buffer.from(JSON.stringify({ envelope_id: fixture.envelope_id })).toString(
            "base64",
          ),
          deposit: "0",
          gas: "150000000000000",
        },
      ],
    },
  });
  await record("close", "DAO closes the budget", "ok", OWNER, r);
}

const phases: Record<string, () => Promise<void>> = { setup, history, scenes, raise, close };
const phase = process.argv[2] ?? "";
if (!phases[phase]) {
  console.error(`usage: demo.ts <${Object.keys(phases).join("|")}>`);
  process.exit(2);
}
await phases[phase]();
