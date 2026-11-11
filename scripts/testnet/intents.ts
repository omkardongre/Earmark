// Feature 3 on testnet: near.com payouts on a throwaway Earmark contract, paid into a copy of the
// real NEAR Intents contract (mainnet `intents.near`'s code; Intents itself has no testnet). The
// "DAO" is the owner account, so no votes are needed. Testnet only; keys stay in the CLI keychain.
//   setup    Intents copy (fresh state), contract with `intents_contract` = the copy, budget
//            "Contributors" funded with 30 tUSDC (lead alice up to 5, approver daniel)
//   flow     add a MetaMask-style 0x… payee as near.com payee → wait → apply; pay 3 at once;
//            pay 8 with one approval; pause the Intents copy → the payment fails, money stays
//   delete   deletes the contract and the Intents copy, NEAR back to the owner
//   Run: pnpm tsx scripts/testnet/intents.ts <step>
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { actions } from "near-api-js";
import {
  accountExists,
  call,
  keychainAccount,
  NEAR,
  type Network,
  RPC,
  view,
  viewAccount,
} from "../lib/near.ts";
import { ensureAccount } from "../lib/testnet.ts";

const network: Network = "testnet";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OWNER = process.env.OWNER ?? "earmark.testnet";
const CONTRACT = process.env.INTENTS_DEV ?? `intents-dev.${OWNER}`;
/** Holds the Intents copy (1.3 MB of code, ~13 testnet NEAR). */
const INTENTS = process.env.INTENTS_COPY ?? "earmark-intents-a.testnet";
const TOKEN = "tusdc.earmark.testnet";
const LEAD = "alice.earmark.testnet";
const APPROVER = "daniel.earmark.testnet";
/** A MetaMask user's id on near.com: "0x" + lowercase address. Nobody signs as it here. */
const PAYEE = process.env.PAYEE ?? "0x8ba1f109551bd432803012645ac136ddd64dba72";
const WASM = resolve(root, "target/near/earmark/earmark.wasm");
const TGAS = 1_000_000_000_000n;
const usdc = (n: number) => String(BigInt(Math.round(n * 1e6)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const as = (id: string) => keychainAccount(network, id);
const v = <T>(contract: string, method: string, args: object = {}) =>
  view<T>(network, contract, method, args);

async function step(label: string, signer: string, method: string, args: object, gasTgas = 30) {
  const r = await call(as(signer), CONTRACT, method, args, { gasTgas });
  console.log(`${r.ok ? "ok  " : "FAIL"} ${label}${r.ok ? "" : `: ${r.error}`} (${r.hash})`);
  return r;
}

/** Gas each receipt of a transaction burnt, to size the contract's constants. */
async function gas(hash: string, sender: string) {
  const res = await fetch(RPC[network], {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tx",
      params: { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" },
    }),
  });
  const { result } = (await res.json()) as {
    result: {
      transaction_outcome: { outcome: { gas_burnt: number } };
      receipts_outcome: { outcome: { gas_burnt: number; executor_id: string } }[];
    };
  };
  const rows = result.receipts_outcome.map(
    (r) => `${r.outcome.executor_id.split(".")[0]} ${(r.outcome.gas_burnt / 1e12).toFixed(1)}`,
  );
  const total =
    result.transaction_outcome.outcome.gas_burnt +
    result.receipts_outcome.reduce((n, r) => n + r.outcome.gas_burnt, 0);
  console.log(`      gas ${(total / 1e12).toFixed(1)} Tgas burnt: ${rows.join(", ")}`);
}

const books = async () => {
  const e = await v<Record<string, string>>(CONTRACT, "get_envelope", { envelope_id: "0" });
  const held = await v<string>(INTENTS, "mt_balance_of", {
    account_id: PAYEE,
    token_id: `nep141:${TOKEN}`,
  });
  return `budget available ${e.available}, paid ${e.spent_total}; payee's near.com balance ${held}`;
};

async function setup() {
  // 1. The Intents copy: mainnet code, fresh state. The owner may pause it (DAO role).
  if ((await viewAccount(network, INTENTS)).code_hash === "11111111111111111111111111111111") {
    const code = await fetch("https://rpc.mainnet.fastnear.com", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "query",
        params: { request_type: "view_code", finality: "final", account_id: "intents.near" },
      }),
    }).then(async (r) => ((await r.json()) as { result: { code_base64: string } }).result);
    const config = {
      wnear_id: "wrap.testnet",
      fees: { fee: 0, fee_collector: INTENTS },
      roles: { grantees: { DAO: [OWNER], UnpauseManager: [OWNER] } },
    };
    await as(INTENTS).signAndSendTransaction({
      receiverId: INTENTS,
      actions: [
        actions.deployContract(Buffer.from(code.code_base64, "base64")),
        actions.functionCall("new", { config }, 100n * TGAS, 0n),
      ],
      waitUntil: "FINAL",
    });
    console.log(`deployed the Intents copy on ${INTENTS}`);
  }

  // 2. Earmark, pointed at the copy.
  if (!(await accountExists(network, CONTRACT))) {
    await ensureAccount(OWNER, CONTRACT, "5.6");
    await as(CONTRACT).signAndSendTransaction({
      receiverId: CONTRACT,
      actions: [
        actions.deployContract(readFileSync(WASM)),
        actions.functionCall(
          "new",
          {
            dao_id: OWNER,
            token_ids: [TOKEN],
            loosen_delay_secs: "60",
            intents_contract: INTENTS,
          },
          30n * TGAS,
          0n,
        ),
      ],
      waitUntil: "FINAL",
    });
    console.log(`deployed ${CONTRACT}`);
  }
  const owner = as(OWNER);
  for (const account of [CONTRACT, INTENTS]) {
    await call(owner, TOKEN, "storage_deposit", { account_id: account }, { deposit: NEAR("0.01") });
  }
  if ((await v<unknown[]>(CONTRACT, "list_envelopes")).length === 0) {
    const created = await call(
      owner,
      CONTRACT,
      "create_envelope",
      {
        envelope: {
          name: "Contributors",
          token_id: TOKEN,
          spenders: [{ account_id: LEAD, auto_limit: usdc(5), period_cap: usdc(100) }],
          approvers: [APPROVER],
          one_approver_limit: usdc(20),
          raise_ceiling: usdc(10),
          payees: [],
          period_secs: "2592000",
          period_cap: usdc(100),
        },
      },
      { deposit: NEAR("0.1") },
    );
    console.log(`${created.ok ? "ok  " : "FAIL"} create budget`);
    const fund = await call(
      owner,
      TOKEN,
      "ft_transfer_call",
      { receiver_id: CONTRACT, amount: usdc(30), msg: JSON.stringify({ envelope_id: "0" }) },
      { deposit: 1n },
    );
    console.log(`${fund.ok ? "ok  " : "FAIL"} fund 30 tUSDC`);
  }
  console.log("     ", JSON.stringify(await v(CONTRACT, "get_config")));
}

async function flow() {
  const payees = await v<string[]>(CONTRACT, "list_intents_payees", { envelope_id: "0" });
  if (!payees.includes(PAYEE)) {
    const queued = await step(
      "approver adds the 0x… payee as near.com payee",
      APPROVER,
      "approve_intents_payee",
      {
        envelope_id: "0",
        payee: PAYEE,
      },
    );
    console.log("      waiting 65 s (the budget's waiting period)…");
    await sleep(65_000);
    await step("apply the change", LEAD, "apply_change", { change_id: String(queued.value) });
  }
  console.log("     ", await books());

  const id = (n: string) => `nc-${n}-${Date.now()}`;
  const pay = (rid: string, amount: number, gasTgas = 100) =>
    step(
      `lead pays ${amount} tUSDC (${rid})`,
      LEAD,
      "request_spend",
      {
        envelope_id: "0",
        request_id: rid,
        payee: PAYEE,
        amount: usdc(amount),
        memo: "near.com test",
        work_ref: `https://example.com/${rid}`,
      },
      gasTgas,
    );
  const status = async (rid: string) => {
    const r = await v<{ status: string; failure: string | null }>(CONTRACT, "get_request", {
      request_id: rid,
    });
    return `${r.status}${r.failure ? ` (${r.failure})` : ""}`;
  };

  // Paid at once, at the gas the app sends.
  const a = id("auto");
  const ra = await pay(a, 3);
  await gas(ra.hash, LEAD);
  console.log(`      ${await status(a)}; ${await books()}`);

  // One approval: the approver's click pays into near.com.
  const b = id("approve");
  await pay(b, 8);
  const rb = await step("approver approves", APPROVER, "approve", { request_id: b }, 100);
  await gas(rb.hash, APPROVER);
  console.log(`      ${await status(b)}; ${await books()}`);

  // Intents paused: refunded, the payment fails, the money stays in the budget.
  const owner = as(OWNER);
  const key = { key: "ft_on_transfer" };
  await call(owner, INTENTS, "pa_pause_feature", key);
  const c = id("paused");
  await pay(c, 2);
  console.log(`      ${await status(c)}; ${await books()}`);
  await call(owner, INTENTS, "pa_unpause_feature", key);
  console.log("      Intents copy unpaused");
}

async function remove() {
  for (const account of [CONTRACT, INTENTS]) {
    await as(account).signAndSendTransaction({
      receiverId: account,
      actions: [actions.deleteAccount(OWNER)],
      waitUntil: "FINAL",
    });
    console.log(`deleted ${account}`);
  }
}

const steps: Record<string, () => Promise<void>> = { setup, flow, delete: remove };
const run = steps[process.argv[2] ?? ""];
if (!run) {
  console.error("usage: intents.ts setup|flow|delete");
  process.exit(1);
}
await run();
