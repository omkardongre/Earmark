// Mainnet code update of the Earmark contract, with a one-time helper account so the Admin's own
// key never leaves their wallet. Rehearsed on a copy of the mainnet state first:
//   cargo test --test sandbox -- --ignored mainnet_upgrade_rehearsal
// Steps (the Admin's two votes happen in the app at /update):
//   tsx scripts/mainnet/upgrade.ts helper   new helper key; prints the address to send NEAR to
//   tsx scripts/mainnet/upgrade.ts store    tops up the contract's free NEAR, stores the code in the DAO
//   tsx scripts/mainnet/upgrade.ts finish   checks the new code runs, takes the blob deposit back,
//                                           deletes the helper and sends everything left to RETURN_TO
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { actions, baseEncode, KeyPair, keyToImplicitAddress } from "near-api-js";
import { call, keychainAccount, NEAR, type Network, view, viewAccount } from "../lib/near.ts";

const network: Network = "mainnet";
const CONTRACT = process.env.CONTRACT ?? "budgets.omkar5.near";
const RETURN_TO = process.env.RETURN_TO ?? "omkar5.near";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const wasm = readFileSync(resolve(root, "target/near/earmark/earmark.wasm"));
const hash = baseEncode(createHash("sha256").update(wasm).digest());
const dir = `${homedir()}/.near-credentials/${network}`;
const pointer = `${dir}/earmark-upgrade-helper.txt`;
const TGAS = 1_000_000_000_000n;
const PER_BYTE = 10n ** 19n;
/**
 * Gas for `store_blob`. It uses about 30 Tgas for 404 KB (sha256 + storage write). The sender
 * must hold prepaid gas × gas price (1e9 yocto on mainnet, Nov 2026), so 300 Tgas would need
 * 0.3 NEAR on top of the deposit; unused gas is refunded.
 */
const STORE_TGAS = 100n;
/** Free NEAR the contract keeps after the update: its 0.5 payment reserve plus 0.05 headroom. */
const KEEP_FREE = NEAR("0.55");
const fmt = (y: bigint) => `${(Number(y) / 1e24).toFixed(4)} NEAR`;

const step = process.argv[2];
if (step === "helper") helper();
else if (step === "store") await store();
else if (step === "finish") await finish();
else throw new Error("usage: upgrade.ts helper | store | finish");

function helperId(): string {
  if (!existsSync(pointer)) throw new Error("no helper yet: run `upgrade.ts helper` first");
  return readFileSync(pointer, "utf8").trim();
}

function helper() {
  if (existsSync(pointer)) {
    console.log(`Helper already made: ${helperId()}`);
    return;
  }
  const key = KeyPair.fromRandom("ed25519");
  const id = keyToImplicitAddress(key.getPublicKey());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = {
    account_id: id,
    public_key: key.getPublicKey().toString(),
    private_key: key.toString(),
  };
  writeFileSync(`${dir}/${id}.json`, JSON.stringify(file), { mode: 0o600 });
  writeFileSync(pointer, id, { mode: 0o600 });
  console.log(`Helper: ${id}\nSend it NEAR on the NEAR network (no memo).`);
}

/** Bytes the contract's storage grows by when its code becomes `wasm`. */
async function growth(): Promise<bigint> {
  const code = await fetch(process.env.NEAR_RPC_MAINNET ?? "https://rpc.mainnet.fastnear.com", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: { request_type: "view_code", finality: "final", account_id: CONTRACT },
    }),
  }).then(async (r) => (await r.json()) as { result: { code_base64: string } });
  const old = Buffer.from(code.result.code_base64, "base64").length;
  return BigInt(wasm.length - old);
}

async function store() {
  const id = helperId();
  const me = keychainAccount(network, id);
  const config = await view<{ dao_id: string }>(network, CONTRACT, "get_config");
  const dao = config.dao_id;
  const blob = PER_BYTE * BigInt(wasm.length + 32);

  const c = await viewAccount(network, CONTRACT);
  if (c.code_hash === hash) {
    console.log(`${CONTRACT} already runs ${hash}`);
    return;
  }
  const freeAfter =
    BigInt(c.amount) - BigInt(c.storage_usage) * PER_BYTE - (await growth()) * PER_BYTE;
  const top =
    freeAfter >= KEEP_FREE ? 0n : ((KEEP_FREE - freeAfter) / 10n ** 22n + 1n) * 10n ** 22n;
  const exists = await view<boolean>(network, dao, "has_blob", { hash }).catch(() => false);
  const need = top + (exists ? 0n : blob) + NEAR("0.122");
  const have = BigInt((await viewAccount(network, id)).amount);
  console.log(`Code ${hash} (${wasm.length} bytes), DAO ${dao}`);
  console.log(
    `Helper has ${fmt(have)}, needs ${fmt(need)} (blob ${fmt(blob)}, top-up ${fmt(top)})`,
  );
  if (have < need) throw new Error(`send the helper ${fmt(need - have)} more`);

  if (top > 0n) {
    const r = await me.signAndSendTransaction({
      receiverId: CONTRACT,
      actions: [actions.transfer(top)],
      waitUntil: "FINAL",
    });
    console.log(`1. Sent ${fmt(top)} to ${CONTRACT}: ${r.transaction.hash}`);
  }
  if (!exists) {
    const r = await me.signAndSendTransaction({
      receiverId: dao,
      actions: [actions.functionCall("store_blob", new Uint8Array(wasm), STORE_TGAS * TGAS, blob)],
      waitUntil: "FINAL",
    });
    console.log(`2. Stored the code in ${dao}: ${r.transaction.hash}`);
  }
  if (!(await view<boolean>(network, dao, "has_blob", { hash }))) throw new Error("blob missing");
  console.log("Next: the Admin opens /update, files the update, then approves it.");
}

async function finish() {
  const id = helperId();
  const me = keychainAccount(network, id);
  const dao = (await view<{ dao_id: string }>(network, CONTRACT, "get_config")).dao_id;
  const running = (await viewAccount(network, CONTRACT)).code_hash;
  if (running !== hash) throw new Error(`${CONTRACT} still runs ${running}; wait for the vote`);
  const budget = await view<object | null>(network, CONTRACT, "get_envelope", { envelope_id: "0" });
  if (!budget) throw new Error("budget 0 doesn't read under the new code");
  console.log(`1. ${CONTRACT} runs ${hash}; budget 0 reads`);

  if (await view<boolean>(network, dao, "has_blob", { hash })) {
    const r = await call(me, dao, "remove_blob", { hash }, { gasTgas: 50 });
    if (!r.ok) throw new Error(`remove_blob: ${r.error}`);
    console.log(`2. Blob deposit back: ${r.hash}`);
  }
  const left = BigInt((await viewAccount(network, id)).amount);
  const r = await me.signAndSendTransaction({
    receiverId: id,
    actions: [actions.deleteAccount(RETURN_TO)],
    waitUntil: "FINAL",
  });
  console.log(`3. Helper deleted, about ${fmt(left)} sent to ${RETURN_TO}: ${r.transaction.hash}`);
}
