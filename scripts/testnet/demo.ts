// Seeds the testnet demo (docs/04 §1) and records every transaction in fixtures/testnet-demo.json,
// which `make demo` replays and `make verify` checks. Testnet only; keys come from the NEAR CLI
// legacy keychain. The DAO uses the policy Trezu (NEAR Business) gives new treasuries: roles
// Requestor / Admin / Approver, proposal bond 0. Run the phases in order:
//   setup    accounts, contract (no keys left), DAO, Earmark as Requestor, budget "News contributors"
//   history  funding, earlier payouts, one approval, one DAO-paid escalation, contract refusals
//   close    the DAO closes the budget (after the video)
// The video scenes (pay, approve, DAO vote, race, raise, pause) are done by hand in the web app.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { actions, KeyPair, PublicKey } from "near-api-js";
import {
  accessKeys,
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
const CONTRACT = process.env.CONTRACT ?? `budgets.${OWNER}`;
const DAO_NAME = process.env.DAO_NAME ?? "community-news";
const FACTORY = "sputnikv2.testnet";
const DAO = `${DAO_NAME}.${FACTORY}`;
const TOKEN = process.env.TOKEN ?? `tusdc.${OWNER}`;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WASM = resolve(root, "target/near/earmark/earmark.wasm");
const FIXTURE = resolve(root, "fixtures/testnet-demo.json");
const TGAS = 1_000_000_000_000n;

const name = (n: string) => `${n}.${OWNER}`;
// Council: Priya is the treasurer (files DAO proposals); all three vote, 2 of 3 decide.
const PRIYA = name("priya");
const DANIEL = name("daniel");
const LENA = name("lena");
// Leads who pay contributors from the budget.
const MAYA = name("maya");
const THEO = name("theo");
// Contributors.
const SOFIA = name("sofia-reyes");
const KENJI = name("kenji-tanaka");
const ANA = name("ana-costa");
const UNKNOWN = name("not-a-contributor");
const COUNCIL = [PRIYA, DANIEL, LENA];
const usdc = (n: number) => String(BigInt(Math.round(n * 1e6)));
const WORK = "https://newsletter.example/2026";

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
  /** DAO members who can file and vote on code upgrades (Admin role). */
  admins: string[];
  code_hash?: string;
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
    admins: COUNCIL,
    accounts: {
      priya: PRIYA,
      daniel: DANIEL,
      lena: LENA,
      maya: MAYA,
      theo: THEO,
      sofia: SOFIA,
      kenji: KENJI,
      ana: ANA,
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
    `${matches ? "ok  " : "FAIL"} ${label.padEnd(46)} -> ${r.ok ? JSON.stringify(r.value) : r.error}  ${r.hash}`,
  );
  if (!matches) throw new Error(`${step}: expected ${expect}`);
}

const as = (id: string) => keychainAccount(network, id);

async function ensureAccount(id: string, near: string) {
  if (await accountExists(network, id)) return;
  const kp = KeyPair.fromRandom("ed25519");
  await as(OWNER).signAndSendTransaction({
    receiverId: id,
    actions: [
      actions.createAccount(),
      actions.transfer(NEAR(near)),
      actions.addFullAccessKey(kp.getPublicKey()),
    ],
    waitUntil: "FINAL",
  });
  writeFileSync(
    `${homedir()}/.near-credentials/${network}/${id}.json`,
    JSON.stringify({
      account_id: id,
      public_key: kp.getPublicKey().toString(),
      private_key: kp.toString(),
    }),
    { mode: 0o600 },
  );
  console.log(`created ${id}`);
}

/** The policy Trezu builds for a new treasury (`nt-be` `build_policy`), with thresholds as counts. */
function trezuPolicy(requestors: string[], admins: string[], approvers: string[], need: number) {
  const votes = (threshold: string) => ({ weight_kind: "RoleWeight", quorum: "0", threshold });
  const admin = votes(String(need));
  const adminKinds = [
    "config",
    "policy",
    "add_member_to_role",
    "remove_member_from_role",
    "upgrade_self",
    "upgrade_remote",
    "set_vote_token",
    "add_bounty",
    "bounty_done",
    "factory_info_update",
    "policy_add_or_update_role",
    "policy_remove_role",
    "policy_update_default_vote_policy",
    "policy_update_parameters",
  ];
  return {
    roles: [
      {
        name: "Requestor",
        kind: { Group: requestors },
        permissions: [
          "call:AddProposal",
          "transfer:AddProposal",
          "call:VoteRemove",
          "transfer:VoteRemove",
        ],
        vote_policy: { transfer: votes("1"), call: votes("1") },
      },
      {
        name: "Admin",
        kind: { Group: admins },
        permissions: adminKinds.map((k) => `${k}:*`),
        vote_policy: Object.fromEntries(adminKinds.map((k) => [k, admin])),
      },
      {
        name: "Approver",
        kind: { Group: approvers },
        permissions: [
          "call:VoteReject",
          "call:VoteApprove",
          "call:RemoveProposal",
          "call:Finalize",
          "transfer:VoteReject",
          "transfer:VoteApprove",
          "transfer:RemoveProposal",
          "transfer:Finalize",
        ],
        vote_policy: { transfer: votes(String(need)), call: votes(String(need)) },
      },
    ],
    default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
    proposal_bond: "0",
    proposal_period: "604800000000000",
    bounty_bond: "0",
    bounty_forgiveness_period: "604800000000000",
  };
}

/** Priya files a proposal; council members vote until it passes. Returns the deciding vote. */
async function daoDo(
  description: string,
  kind: object,
): Promise<CallResult & { proposalId: number }> {
  const policy = await view<{ proposal_bond: string }>(network, DAO, "get_policy");
  const added = await call(
    as(PRIYA),
    DAO,
    "add_proposal",
    { proposal: { description, kind } },
    { gasTgas: 50, deposit: BigInt(policy.proposal_bond) },
  );
  if (!added.ok) throw new Error(`add_proposal: ${added.error}`);
  const proposalId = Number(added.value);
  return { ...(await voteUntilApproved(proposalId)), proposalId };
}

async function voteUntilApproved(id: number, voters = COUNCIL): Promise<CallResult> {
  const stored = await view<{ kind: object }>(network, DAO, "get_proposal", { id });
  for (const voter of voters) {
    const voted = await call(
      as(voter),
      DAO,
      "act_proposal",
      { id, action: "VoteApprove", proposal: stored.kind },
      { gasTgas: 200 },
    );
    const after = await view<{ status: string }>(network, DAO, "get_proposal", { id });
    if (after.status === "Approved") return voted;
    if (after.status !== "InProgress") throw new Error(`proposal ${id}: ${after.status}`);
  }
  throw new Error(`proposal ${id} not approved by ${voters.join(", ")}`);
}

async function fund(step: string, amount: number) {
  const r = await daoDo(
    `* Title: Fund Earmark budget "News contributors" <br>* Notes: ${amount} tUSDC`,
    {
      Transfer: {
        token_id: TOKEN,
        receiver_id: CONTRACT,
        amount: usdc(amount),
        msg: JSON.stringify({ envelope_id: fixture.envelope_id }),
      },
    },
  );
  await record(step, `DAO funds the budget with ${amount}`, "ok", PRIYA, r);
}

let seq = 0;
const runId = Date.now().toString(36);
const rid = (tag: string) => `${runId}-${tag}-${++seq}`;

function spend(
  spender: string,
  payee: string,
  amount: number,
  work: string,
  memo: string,
  requestId = rid("pay"),
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
      memo,
      work_ref: work,
    },
    { gasTgas: 200 },
  );
}

async function setup() {
  for (const id of [...COUNCIL, MAYA, THEO]) await ensureAccount(id, "0.3");
  for (const id of [SOFIA, KENJI, ANA]) await ensureAccount(id, "0.1");

  if (!(await accountExists(network, DAO))) {
    const policy = trezuPolicy([PRIYA], COUNCIL, COUNCIL, 2);
    const args = {
      config: { name: DAO_NAME, purpose: "Community newsletter treasury", metadata: "" },
      policy,
    };
    const created = await call(
      as(OWNER),
      FACTORY,
      "create",
      { name: DAO_NAME, args: Buffer.from(JSON.stringify(args)).toString("base64") },
      { gasTgas: 150, deposit: NEAR("6") },
    );
    if (!created.ok) throw new Error(`create DAO: ${created.error}`);
    console.log(`created DAO ${DAO}`);
  }

  if (!(await accountExists(network, CONTRACT))) {
    await ensureAccount(CONTRACT, "5.2");
    await as(CONTRACT).signAndSendTransaction({
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
          30n * TGAS,
          0n,
        ),
      ],
      waitUntil: "FINAL",
    });
    console.log(`deployed ${CONTRACT}`);
  }
  // No admin key (R12): from here only a DAO UpgradeRemote vote can change the code.
  const full = (await accessKeys(network, CONTRACT)).filter(
    (k) => k.access_key.permission === "FullAccess",
  );
  if (full.length > 0) {
    await as(CONTRACT).signAndSendTransaction({
      receiverId: CONTRACT,
      actions: full.map((k) => actions.deleteKey(PublicKey.fromString(k.public_key))),
      waitUntil: "FINAL",
    });
    console.log(`deleted ${full.length} key(s) of ${CONTRACT}`);
  }

  const owner = as(OWNER);
  const bounds = await view<{ min: string }>(network, TOKEN, "storage_balance_bounds");
  for (const id of [CONTRACT, DAO, SOFIA, KENJI, ANA]) {
    const bal = await view<unknown>(network, TOKEN, "storage_balance_of", { account_id: id });
    if (!bal) {
      await call(
        owner,
        TOKEN,
        "storage_deposit",
        { account_id: id, registration_only: true },
        { gasTgas: 30, deposit: BigInt(bounds.min) },
      );
    }
  }

  // Earmark files escalations, so it joins Requestor (as NEARN does with nearn-io.near).
  const policy = await view<{ roles: { name: string; kind: { Group?: string[] } }[] }>(
    network,
    DAO,
    "get_policy",
  );
  const requestors = policy.roles.find((r) => r.name === "Requestor")?.kind.Group ?? [];
  if (!requestors.includes(CONTRACT)) {
    const r = await daoDo(
      `* Title: Add Earmark as Requestor <br>* Notes: ${CONTRACT} files payments above the budget's approval limit as DAO votes`,
      {
        AddMemberToRole: { member_id: CONTRACT, role: "Requestor" },
      },
    );
    await record("requestor", "DAO adds Earmark to the Requestor role", "ok", PRIYA, r);
  }

  if (fixture.envelope_id === "") {
    const envelope = {
      name: "News contributors",
      token_id: TOKEN,
      spenders: [
        { account_id: MAYA, auto_limit: usdc(10), period_cap: usdc(200) },
        { account_id: THEO, auto_limit: usdc(10), period_cap: usdc(200) },
      ],
      approvers: COUNCIL,
      one_approver_limit: usdc(50),
      raise_ceiling: usdc(25),
      payees: [SOFIA, KENJI, ANA],
      period_secs: "2592000",
      period_cap: usdc(500),
    };
    const before = await view<{ envelope_count: string }>(network, CONTRACT, "get_config");
    const r = await daoDo(
      '* Title: Create Earmark budget "News contributors" <br>* Notes: leads Maya and Theo pay up to 10 at once; up to 50 with one council approval; above that, a DAO vote',
      {
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
      },
    );
    fixture.envelope_id = before.envelope_count;
    save();
    await record("create", 'DAO creates budget "News contributors"', "ok", PRIYA, r);
  }
}

async function history() {
  const owner = as(OWNER);
  // 170 for the budget (100 left after these payouts) and 500 in the DAO's own treasury.
  await call(owner, TOKEN, "mint", { account_id: DAO, amount: usdc(670) }, { gasTgas: 30 });
  await fund("fund", 170);

  const paid: [string, string, string, number, string, string][] = [
    ["roundup-211", MAYA, SOFIA, 6, "issue-211/ecosystem-roundup", "Ecosystem roundup, issue 211"],
    ["photos-211", MAYA, KENJI, 8, "issue-211/meetup-photos", "Meetup photos, issue 211"],
    ["header-211", THEO, ANA, 7, "issue-211/header-art", "Header art, issue 211"],
    ["roundup-212", MAYA, SOFIA, 6, "issue-212/ecosystem-roundup", "Ecosystem roundup, issue 212"],
    ["charts-212", MAYA, ANA, 9, "issue-212/grant-charts", "Grant charts, issue 212"],
    ["recap-212", THEO, SOFIA, 5, "issue-212/governance-recap", "Governance recap, issue 212"],
  ];
  for (const [step, lead, payee, amount, path, memo] of paid) {
    const who = lead === MAYA ? "maya" : "theo";
    await record(
      step,
      `${who} pays ${payee.split(".")[0]} ${amount}`,
      "ok paid",
      lead,
      await spend(lead, payee, amount, `${WORK}/${path}`, memo),
    );
  }

  const interview = rid("pay");
  await record(
    "interview-ask",
    "maya asks 35 for kenji (needs one approval)",
    "ok pending_approval",
    MAYA,
    await spend(
      MAYA,
      KENJI,
      35,
      `${WORK}/issue-212/founder-interview`,
      "Founder interview, issue 212",
      interview,
    ),
  );
  await record(
    "interview-approve",
    "daniel approves the 35",
    "ok paid",
    DANIEL,
    await call(as(DANIEL), CONTRACT, "approve", { request_id: interview }, { gasTgas: 100 }),
  );

  // Above the one-approver limit: a DAO Transfer proposal, paid from the DAO's treasury.
  const report = rid("pay");
  await record(
    "report-escalate",
    "maya asks 120 for sofia (DAO vote)",
    "ok escalated",
    MAYA,
    await spend(MAYA, SOFIA, 120, `${WORK}/q4-ecosystem-report`, "Q4 ecosystem report", report),
  );
  const req = await view<{ dao_proposal_id: string }>(network, CONTRACT, "get_request", {
    request_id: report,
  });
  await record(
    "report-vote",
    `council approves DAO proposal ${req.dao_proposal_id}`,
    "ok",
    LENA,
    await voteUntilApproved(Number(req.dao_proposal_id), [LENA, DANIEL]),
  );
  await new Promise((r) => setTimeout(r, 3000));
  await record(
    "report-settle",
    "record the DAO result",
    "ok paid_by_dao",
    OWNER,
    await call(owner, CONTRACT, "settle_escalation", { request_id: report }, { gasTgas: 80 }),
  );

  // Refusals: failed calls change nothing and add nothing to the activity feed.
  await record(
    "unknown-payee",
    "maya pays an account that isn't a contributor",
    "rejected payee_not_allowed",
    MAYA,
    await spend(MAYA, UNKNOWN, 5, `${WORK}/issue-212/guest-post`, "Guest post"),
  );
  await record(
    "duplicate-work",
    "maya pays sofia again for the same roundup",
    "rejected duplicate_work",
    MAYA,
    await spend(
      MAYA,
      SOFIA,
      6,
      `${WORK}/issue-212/ecosystem-roundup`,
      "Ecosystem roundup, issue 212",
    ),
  );
  const retry = rid("pay");
  await record(
    "event-photo",
    "theo pays kenji 4",
    "ok paid",
    THEO,
    await spend(THEO, KENJI, 4, `${WORK}/issue-212/event-photo`, "Event photo", retry),
  );
  await record(
    "duplicate-request",
    "network retry with the same request id",
    "rejected duplicate_request",
    THEO,
    await spend(THEO, KENJI, 4, `${WORK}/issue-212/event-photo-2`, "Event photo", retry),
  );
  await record(
    "not-spender",
    "lena (approver, not a lead) tries to pay",
    "rejected not_spender",
    LENA,
    await spend(LENA, ANA, 5, `${WORK}/issue-212/cover`, "Cover"),
  );
}

async function close() {
  const r = await daoDo(`* Title: Close Earmark budget "News contributors"`, {
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
  await record("close", "DAO closes the budget", "ok", PRIYA, r);
}

const phases: Record<string, () => Promise<void>> = { setup, history, close };
const phase = process.argv[2] ?? "";
if (!phases[phase]) {
  console.error(`usage: demo.ts <${Object.keys(phases).join("|")}>`);
  process.exit(2);
}
await phases[phase]();
