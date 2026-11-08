// Installs target/near/earmark/earmark.wasm on the demo contract through a DAO `UpgradeRemote`
// vote and makes sure the contract has no full-access key (R12), so a DAO vote is the only way to
// change its code. Contract, DAO and the Admin members who vote come from
// fixtures/testnet-demo.json. Testnet only.
//   tsx scripts/testnet/lock.ts
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { actions, baseEncode, PublicKey } from "near-api-js";
import { accessKeys, call, keychainAccount, type Network, view, viewAccount } from "../lib/near.ts";

const network: Network = "testnet";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixturePath = resolve(root, "fixtures/testnet-demo.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  contract: string;
  dao: string;
  admins?: string[];
};
const OWNER = process.env.OWNER ?? "earmark.testnet";
const CONTRACT = process.env.CONTRACT ?? fixture.contract;
const DAO = process.env.DAO ?? fixture.dao;
const ADMINS = fixture.admins ?? [OWNER];
const wasm = readFileSync(resolve(root, "target/near/earmark/earmark.wasm"));
const hash = baseEncode(createHash("sha256").update(wasm).digest());
const TGAS = 1_000_000_000_000n;

const config = await view<{ dao_id: string }>(network, CONTRACT, "get_config");
if (config.dao_id !== DAO) throw new Error(`${CONTRACT} is owned by ${config.dao_id}, not ${DAO}`);

if ((await viewAccount(network, CONTRACT)).code_hash === hash) {
  console.log(`1-3. ${CONTRACT} already runs code ${hash}; no upgrade needed`);
} else {
  await upgrade();
}

async function upgrade() {
  console.log(`1. Store the wasm as a DAO blob (${hash})`);
  const owner = keychainAccount(network, OWNER);
  const exists = await view<boolean>(network, DAO, "has_blob", { hash }).catch(() => false);
  if (!exists) {
    const deposit = 10n ** 19n * BigInt(wasm.length + 32);
    await owner.signAndSendTransaction({
      receiverId: DAO,
      actions: [actions.functionCall("store_blob", new Uint8Array(wasm), 300n * TGAS, deposit)],
      waitUntil: "FINAL",
    });
  }

  console.log("2. DAO proposal: UpgradeRemote -> upgrade");
  const policy = await view<{ proposal_bond: string }>(network, DAO, "get_policy");
  const [proposer, ...rest] = ADMINS.map((a) => keychainAccount(network, a));
  if (!proposer) throw new Error("no Admin member in the fixture");
  const added = await call(
    proposer,
    DAO,
    "add_proposal",
    {
      proposal: {
        description: `* Title: Upgrade Earmark contract ${CONTRACT} <br>* Notes: code ${hash}`,
        kind: { UpgradeRemote: { receiver_id: CONTRACT, method_name: "upgrade", hash } },
      },
    },
    { gasTgas: 50, deposit: BigInt(policy.proposal_bond) },
  );
  if (!added.ok) throw new Error(`add_proposal: ${added.error}`);
  const id = Number(added.value);
  const stored = await view<{ kind: object }>(network, DAO, "get_proposal", { id });
  // Admins vote until the proposal passes (the policy decides how many it takes).
  for (const voter of [proposer, ...rest]) {
    const voted = await call(
      voter,
      DAO,
      "act_proposal",
      { id, action: "VoteApprove", proposal: stored.kind },
      { gasTgas: 250 },
    );
    if (!voted.ok) throw new Error(`vote failed: ${voted.error} (${voted.hash})`);
    const { status } = await view<{ status: string }>(network, DAO, "get_proposal", { id });
    if (status === "Approved") {
      console.log(`   proposal ${id} approved, tx ${voted.hash}`);
      break;
    }
  }

  const deployed = (await viewAccount(network, CONTRACT)).code_hash;
  if (deployed !== hash) throw new Error(`code hash ${deployed} != ${hash}`);
  await view(network, CONTRACT, "get_config");
  console.log("   code hash matches and state still reads");

  console.log("3. Return the blob deposit");
  await call(owner, DAO, "remove_blob", { hash }, { gasTgas: 50 });
}

// `make verify` checks the deployed code against this hash.
const fresh = JSON.parse(readFileSync(fixturePath, "utf8")) as { contract: string };
if (fresh.contract === CONTRACT) {
  writeFileSync(fixturePath, `${JSON.stringify({ ...fresh, code_hash: hash }, null, 2)}\n`);
  console.log("   recorded the code hash in fixtures/testnet-demo.json");
}

console.log("4. Delete the contract's full-access keys");
const full = (await accessKeys(network, CONTRACT)).filter(
  (k) => k.access_key.permission === "FullAccess",
);
if (full.length > 0) {
  await keychainAccount(network, CONTRACT).signAndSendTransaction({
    receiverId: CONTRACT,
    actions: full.map((k) => actions.deleteKey(PublicKey.fromString(k.public_key))),
    waitUntil: "FINAL",
  });
}
const left = await accessKeys(network, CONTRACT);
console.log(
  left.length === 0 ? `   ${CONTRACT} has no access keys` : `   keys left: ${JSON.stringify(left)}`,
);
