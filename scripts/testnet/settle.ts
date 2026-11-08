// Records the DAO's decision on escalated requests (R18). Anyone may call `settle_escalation`;
// this signs as SIGNER (default earmark.testnet) from the CLI keychain. Contract and budget come
// from fixtures/testnet-demo.json. Testnet only.
//   tsx scripts/testnet/settle.ts               # every escalated request in the demo budget
//   tsx scripts/testnet/settle.ts <request_id>  # one request
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { call, keychainAccount, type Network, view } from "../lib/near.ts";

const network: Network = "testnet";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fx = JSON.parse(readFileSync(resolve(root, "fixtures/testnet-demo.json"), "utf8")) as {
  contract: string;
  envelope_id: string;
};
const CONTRACT = process.env.CONTRACT ?? fx.contract;
const ENVELOPE = process.env.ENVELOPE ?? fx.envelope_id;
const signer = keychainAccount(network, process.env.SIGNER ?? "earmark.testnet");

type Request = { status: string; dao_proposal_id: string | null };

let ids = process.argv.slice(2);
if (ids.length === 0) {
  const all = await view<[string, Request][]>(network, CONTRACT, "list_requests", {
    envelope_id: ENVELOPE,
    limit: 100,
  });
  ids = all.filter(([, r]) => r.status === "escalated").map(([id]) => id);
}
if (ids.length === 0) console.log("No escalated requests.");
for (const id of ids) {
  const r = await call(signer, CONTRACT, "settle_escalation", { request_id: id }, { gasTgas: 80 });
  console.log(`${id}: ${r.ok ? String(r.value) : `failed ${r.error}`}  tx ${r.hash}`);
}
