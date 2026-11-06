// Locks the testnet contract (R12): proves the DAO can upgrade it, then deletes its full-access
// keys, so a DAO `UpgradeRemote` proposal is the only way to change its code. Testnet only.
//   tsx scripts/testnet/lock.ts
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { actions, baseEncode, PublicKey } from "near-api-js";
import { accessKeys, call, keychainAccount, type Network, view, viewAccount } from "../lib/near.ts";

const network: Network = "testnet";
const OWNER = process.env.OWNER ?? "earmark.testnet";
const CONTRACT = process.env.CONTRACT ?? `v4.${OWNER}`;
const DAO = process.env.DAO ?? "earmark-demo.sputnikv2.testnet";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const wasm = readFileSync(resolve(root, "target/near/earmark/earmark.wasm"));
const hash = baseEncode(createHash("sha256").update(wasm).digest());
const TGAS = 1_000_000_000_000n;
const owner = keychainAccount(network, OWNER);

const config = await view<{ dao_id: string }>(network, CONTRACT, "get_config");
if (config.dao_id !== DAO) throw new Error(`${CONTRACT} is owned by ${config.dao_id}, not ${DAO}`);

if ((await viewAccount(network, CONTRACT)).code_hash === hash) {
  console.log(`1-3. ${CONTRACT} already runs code ${hash}; no upgrade needed`);
} else {
  await upgrade();
}

async function upgrade() {
  console.log(`1. Store the wasm as a DAO blob (${hash})`);
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
  const added = await call(
    owner,
    DAO,
    "add_proposal",
    {
      proposal: {
        description: `Upgrade Earmark contract ${CONTRACT} to code ${hash}`,
        kind: { UpgradeRemote: { receiver_id: CONTRACT, method_name: "upgrade", hash } },
      },
    },
    { gasTgas: 50, deposit: BigInt(policy.proposal_bond) },
  );
  if (!added.ok) throw new Error(`add_proposal: ${added.error}`);
  const id = Number(added.value);
  const stored = await view<{ kind: object }>(network, DAO, "get_proposal", { id });
  const voted = await call(
    owner,
    DAO,
    "act_proposal",
    { id, action: "VoteApprove", proposal: stored.kind },
    { gasTgas: 300 },
  );
  if (!voted.ok) throw new Error(`upgrade failed: ${voted.error} (${voted.hash})`);
  console.log(`   proposal ${id} approved, tx ${voted.hash}`);

  const deployed = (await viewAccount(network, CONTRACT)).code_hash;
  if (deployed !== hash) throw new Error(`code hash ${deployed} != ${hash}`);
  await view(network, CONTRACT, "get_config");
  console.log("   code hash matches and state still reads");

  console.log("3. Return the blob deposit");
  await call(owner, DAO, "remove_blob", { hash }, { gasTgas: 50 });
}

console.log("4. Delete the contract's full-access keys");
const contract = keychainAccount(network, CONTRACT);
const full = (await accessKeys(network, CONTRACT)).filter(
  (k) => k.access_key.permission === "FullAccess",
);
if (full.length > 0) {
  await contract.signAndSendTransaction({
    receiverId: CONTRACT,
    actions: full.map((k) => actions.deleteKey(PublicKey.fromString(k.public_key))),
    waitUntil: "FINAL",
  });
}
const left = await accessKeys(network, CONTRACT);
console.log(
  left.length === 0 ? `   ${CONTRACT} has no access keys` : `   keys left: ${JSON.stringify(left)}`,
);
