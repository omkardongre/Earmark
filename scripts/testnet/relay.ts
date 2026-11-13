// Fees paid by Earmark (feature 8, docs/05-feature-4-8-plan.md §4), testnet helpers.
//   account          creates gas.earmark.testnet (2 NEAR, key in ~/.near-credentials) and prints
//                    the command that stores its key in Secret Manager
//   zero <account>   leaves <account> with almost no free NEAR (sends the rest to earmark.testnet)
//   carol            creates carol.earmark.testnet with almost no NEAR and makes her an approver
//                    of budget 0 by DAO vote (for the wallet test: approve with 0 NEAR)
//   smoke <app-url>  maya asks for 10.5 tUSDC (over her 10 limit) and priya (or $APPROVER) approves, both signed
//                    locally as delegate actions and relayed by <app-url>/api/relay; checks that
//                    the request was decided by the approver and the sponsor paid the gas
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { actions, encodeSignedDelegate } from "near-api-js";
import { call, keychainAccount, NEAR, view } from "../lib/near.ts";
import { daoDo, ensureAccount, functionCallKind } from "../lib/testnet.ts";

const network = "testnet";
const OWNER = "earmark.testnet";
const SPONSOR = "gas.earmark.testnet";
const CONTRACT = process.env.CONTRACT ?? "budgets.earmark.testnet";
const TGAS = 10n ** 12n;

async function signAndRelay(app: string, signer: string, method: string, args: object) {
  const { signedDelegate } = await keychainAccount(network, signer).createSignedMetaTransaction({
    receiverId: CONTRACT,
    actions: [actions.functionCall(method, args, 100n * TGAS, 0n)],
    blockHeightTtl: 120,
  });
  const res = await fetch(`${app}/api/relay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      signedDelegate: Buffer.from(encodeSignedDelegate(signedDelegate)).toString("base64"),
    }),
  });
  const body = (await res.json()) as {
    error?: string;
    outcome?: {
      transaction: { hash: string; signer_id: string };
      status: { SuccessValue?: string; Failure?: unknown };
      receipts_outcome: { outcome: { executor_id: string; status: Record<string, unknown> } }[];
    };
  };
  if (!res.ok || !body.outcome) throw new Error(`${method}: ${res.status} ${body.error}`);
  const o = body.outcome;
  const value = o.status.SuccessValue
    ? Buffer.from(o.status.SuccessValue, "base64").toString()
    : JSON.stringify(o.status);
  console.log(
    `${method} by ${signer}: tx ${o.transaction.hash}, signer ${o.transaction.signer_id}`,
  );
  console.log(`  final status ${value}`);
  for (const r of o.receipts_outcome) {
    console.log(`  receipt on ${r.outcome.executor_id}: ${JSON.stringify(r.outcome.status)}`);
  }
  // The relayed transaction succeeds even when the call inside fails: check every receipt.
  const failed = o.receipts_outcome.find((r) => "Failure" in r.outcome.status);
  if (failed) throw new Error(`${method} failed: ${JSON.stringify(failed.outcome.status)}`);
  return o;
}

async function freeNear(account: string) {
  const a = await keychainAccount(network, OWNER).provider.viewAccount({ accountId: account });
  return Number(BigInt(a.amount) - BigInt(a.storage_usage) * 10n ** 19n) / 1e24;
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "account") {
  await ensureAccount(OWNER, SPONSOR, "2");
  const file = `${homedir()}/.near-credentials/${network}/${SPONSOR}.json`;
  JSON.parse(readFileSync(file, "utf8"));
  console.log(`${SPONSOR} free NEAR: ${await freeNear(SPONSOR)}`);
  console.log(
    `Store its key: jq -r .private_key ${file} | gcloud secrets create relayer-key --data-file=-`,
  );
} else if (cmd === "carol") {
  const CAROL = "carol.earmark.testnet";
  // Storage for a new account (182 bytes) is ~0.0018 NEAR; 0.0025 leaves ~0.0007 to spend.
  await ensureAccount(OWNER, CAROL, "0.0025");
  const budget = await view<{ approvers: string[] }>(network, CONTRACT, "get_envelope", {
    envelope_id: "0",
  });
  if (!budget.approvers.includes(CAROL)) {
    const { dao_id: dao } = await view<{ dao_id: string }>(network, CONTRACT, "get_config");
    const voters = ["priya.earmark.testnet", "daniel.earmark.testnet", "lena.earmark.testnet"];
    const r = await daoDo(
      dao,
      "priya.earmark.testnet",
      voters,
      "Add carol as an approver of News contributors (fees-paid-by-Earmark test)",
      functionCallKind(CONTRACT, "update_envelope", {
        envelope_id: "0",
        changes: [{ add_approver: { approver: CAROL } }],
      }),
    );
    console.log(`DAO proposal ${r.proposalId}: ${r.ok ? "passed" : r.error}`);
    const queued = await view<[string, { change: object }][]>(network, CONTRACT, "list_queued", {
      envelope_id: "0",
    });
    const id = queued.find(([, c]) => JSON.stringify(c.change).includes(CAROL))?.[0];
    if (!id) throw new Error("change not queued");
    console.log(`change ${id} queued; applying after the waiting period`);
    await new Promise((res) => setTimeout(res, 125_000));
    const applied = await call(keychainAccount(network, OWNER), CONTRACT, "apply_change", {
      change_id: id,
    });
    console.log(`apply_change: ${applied.ok ? "applied" : applied.error}`);
  }
  console.log(`${CAROL} free NEAR: ${await freeNear(CAROL)}`);
} else if (cmd === "zero" && arg) {
  const a = await keychainAccount(network, OWNER).provider.viewAccount({ accountId: arg });
  // Keep the storage it needs plus ~0.0001 NEAR; the transfer itself burns ~0.00005.
  const keep = BigInt(a.storage_usage) * 10n ** 19n + NEAR("0.0002");
  const send = BigInt(a.amount) - keep;
  if (send > 0n) {
    await keychainAccount(network, arg).signAndSendTransaction({
      receiverId: OWNER,
      actions: [actions.transfer(send)],
      waitUntil: "FINAL",
    });
  }
  console.log(`${arg} free NEAR now: ${await freeNear(arg)}`);
} else if (cmd === "smoke" && arg) {
  const app = arg.replace(/\/$/, "");
  const id = `relay-${randomUUID().slice(0, 12)}`;
  // APPROVER=carol.earmark.testnet shows an approval from an account with almost no NEAR.
  const approver = process.env.APPROVER ?? "priya.earmark.testnet";
  console.log(`${approver} free NEAR before: ${await freeNear(approver)}`);
  await signAndRelay(app, "maya.earmark.testnet", "request_spend", {
    envelope_id: "0",
    request_id: id,
    payee: "bob.earmark.testnet",
    amount: "10500000",
    memo: "Relay smoke test",
    work_ref: `https://earmark.example/relay-smoke/${id}`,
  });
  await signAndRelay(app, approver, "approve", { request_id: id });
  const req = await view<{ status: string; decided_by: string | null }>(
    network,
    CONTRACT,
    "get_request",
    { request_id: id },
  );
  console.log(`request ${id}: ${req.status}, decided by ${req.decided_by}`);
  console.log(`${approver} free NEAR after: ${await freeNear(approver)}`);
  if (req.decided_by !== approver) process.exit(1);
} else if (cmd === "accept" && arg && process.argv[4]) {
  // maya accepts a task's work through the relay: `accept <app-url> <task-id>`.
  await signAndRelay(arg.replace(/\/$/, ""), "maya.earmark.testnet", "accept_task", {
    task_id: process.argv[4],
  });
} else if (cmd === "ask" && arg) {
  // One payment over maya's limit, left waiting: for checking the Telegram alert by hand.
  const id = `ask-${randomUUID().slice(0, 12)}`;
  await signAndRelay(arg.replace(/\/$/, ""), "maya.earmark.testnet", "request_spend", {
    envelope_id: "0",
    request_id: id,
    payee: "bob.earmark.testnet",
    amount: "10500000",
    memo: "Logo update",
    work_ref: `https://earmark.example/work/${id}`,
  });
  console.log(`waiting for approval: ${id}`);
} else {
  console.log("usage: relay.ts account | carol | zero <account> | smoke <app-url> | ask <app-url>");
  process.exit(2);
}
