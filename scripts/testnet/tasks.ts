// Dry run of tasks (bounties) on a throwaway testnet contract, before the demo contracts get the
// upgrade. The "DAO" is the owner account itself, so no votes are needed. Testnet only; keys stay
// in the CLI keychain.
//   setup    contract (new wasm), budget "Docs" funded with 60 tUSDC, trust on (1 task, 30 tUSDC)
//   flow     post → claim → submit → accept (paid at once), then a 20 tUSDC task that a trusted
//            contributor is paid at once for, above the lead's own 5 tUSDC limit
//   delete   deletes the throwaway contract account, NEAR back to the owner
//   Run: pnpm tsx scripts/testnet/tasks.ts <step>
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { actions } from "near-api-js";
import { accountExists, call, keychainAccount, NEAR, type Network, view } from "../lib/near.ts";
import { ensureAccount } from "../lib/testnet.ts";

const network: Network = "testnet";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OWNER = process.env.OWNER ?? "earmark.testnet";
const CONTRACT = process.env.TASKS_CONTRACT ?? `tasks-dev.${OWNER}`;
const TOKEN = "tusdc.earmark.testnet";
const LEAD = "alice.earmark.testnet";
const APPROVER = "daniel.earmark.testnet";
const PAYEE = "ana-costa.earmark.testnet";
const WASM = resolve(root, "target/near/earmark/earmark.wasm");
const TGAS = 1_000_000_000_000n;
const usdc = (n: number) => String(BigInt(Math.round(n * 1e6)));

const as = (id: string) => keychainAccount(network, id);
async function step(label: string, signer: string, method: string, args: object, deposit = 0n) {
  // Paying calls need 100 Tgas; the rest 30, which a payee with 0.1 NEAR can prepay.
  const gasTgas = method === "accept_task" ? 100 : 30;
  const r = await call(as(signer), CONTRACT, method, args, { gasTgas, deposit });
  console.log(`${r.ok ? "ok  " : "FAIL"} ${label}${r.ok ? "" : `: ${r.error}`} (${r.hash})`);
  return r;
}
const v = <T>(method: string, args: object) => view<T>(network, CONTRACT, method, args);

async function setup() {
  if (!(await accountExists(network, CONTRACT))) {
    await ensureAccount(OWNER, CONTRACT, "5.2");
    await as(CONTRACT).signAndSendTransaction({
      receiverId: CONTRACT,
      actions: [
        actions.deployContract(readFileSync(WASM)),
        actions.functionCall(
          "new",
          { dao_id: OWNER, token_ids: [TOKEN], loosen_delay_secs: "60" },
          30n * TGAS,
          0n,
        ),
      ],
      waitUntil: "FINAL",
    });
    console.log(`deployed ${CONTRACT}`);
  }
  const owner = as(OWNER);
  await call(owner, TOKEN, "storage_deposit", { account_id: CONTRACT }, { deposit: NEAR("0.01") });
  if ((await v<number[]>("list_envelopes", {})).length === 0) {
    await step(
      "create budget",
      OWNER,
      "create_envelope",
      {
        envelope: {
          name: "Docs",
          token_id: TOKEN,
          spenders: [{ account_id: LEAD, auto_limit: usdc(5), period_cap: usdc(100) }],
          approvers: [APPROVER],
          one_approver_limit: usdc(50),
          raise_ceiling: usdc(25),
          payees: [PAYEE],
          period_secs: "2592000",
          period_cap: usdc(200),
        },
      },
      NEAR("0.1"),
    );
    const fund = await call(
      owner,
      TOKEN,
      "ft_transfer_call",
      {
        receiver_id: CONTRACT,
        amount: usdc(60),
        msg: JSON.stringify({ envelope_id: "0" }),
      },
      { deposit: 1n },
    );
    console.log(`${fund.ok ? "ok  " : "FAIL"} fund 60 tUSDC`);
  }
  await step("trust on: 1 task, up to 30", OWNER, "set_task_rules", {
    envelope_id: "0",
    rules: {
      trusted_limit: usdc(30),
      min_tasks: 1,
      min_days: 0,
      strike_days: 90,
      min_task_amount: "0",
    },
  });
}

async function flow() {
  const env = () =>
    v<Record<string, string>>("get_envelope", { envelope_id: "0" }).then(
      (e) => `available ${e.available}, set aside ${e.committed}, paid ${e.spent_total}`,
    );
  const first = await step("post 4 tUSDC", LEAD, "post_task", {
    envelope_id: "0",
    title: "Fix the setup guide",
    brief: "https://example.com/brief",
    amount: usdc(4),
  });
  const id = String(first.value);
  console.log("     ", await env());
  await step("lead claims own task (must fail)", LEAD, "claim_task", { task_id: id });
  await step("payee claims", PAYEE, "claim_task", { task_id: id });
  await step("payee sends the work", PAYEE, "submit_work", {
    task_id: id,
    work_ref: "https://example.com/pr/101",
  });
  console.log("      check_accept", JSON.stringify(await v("check_accept", { task_id: id })));
  await step("lead accepts", LEAD, "accept_task", { task_id: id });
  const t = await v<{ status: string; request_id: string }>("get_task", { task_id: id });
  console.log(`      task ${t.status}, payment ${t.request_id}; ${await env()}`);
  console.log(
    "      trust",
    JSON.stringify(
      await v("get_contributor_trust", {
        envelope_id: "0",
        account_id: PAYEE,
      }),
    ),
  );

  const big = await step("post 20 tUSDC", LEAD, "post_task", {
    envelope_id: "0",
    title: "Write the API page",
    brief: "",
    amount: usdc(20),
  });
  const id2 = String(big.value);
  await step("payee claims", PAYEE, "claim_task", { task_id: id2 });
  await step("payee sends the work", PAYEE, "submit_work", {
    task_id: id2,
    work_ref: "https://example.com/pr/102",
  });
  console.log("      check_accept", JSON.stringify(await v("check_accept", { task_id: id2 })));
  await step("lead accepts (trusted: no approver)", LEAD, "accept_task", { task_id: id2 });
  const t2 = await v<{ status: string; request_id: string | null }>("get_task", { task_id: id2 });
  if (t2.request_id) {
    const r2 = await v<{ tier: string; status: string }>("get_request", {
      request_id: t2.request_id,
    });
    console.log(`      task ${t2.status}, payment ${r2.tier} ${r2.status}; ${await env()}`);
  }
}

async function remove() {
  await as(CONTRACT).signAndSendTransaction({
    receiverId: CONTRACT,
    actions: [actions.deleteAccount(OWNER)],
    waitUntil: "FINAL",
  });
  console.log(`deleted ${CONTRACT}`);
}

const steps: Record<string, () => Promise<void>> = { setup, flow, delete: remove };
const run = steps[process.argv[2] ?? ""];
if (!run) {
  console.error("usage: tasks.ts setup|flow|delete");
  process.exit(1);
}
await run();
