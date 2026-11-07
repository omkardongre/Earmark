// Records the DAO's decision on escalated requests (R18). Anyone may call `settle_escalation`;
// this signs as SIGNER (default earmark.testnet) from the CLI keychain. Testnet only.
//   tsx scripts/testnet/settle.ts               # every escalated request in budget 0
//   tsx scripts/testnet/settle.ts <request_id>  # one request
import { call, keychainAccount, type Network, view } from "../lib/near.ts";

const network: Network = "testnet";
const CONTRACT = process.env.CONTRACT ?? "v4.earmark.testnet";
const ENVELOPE = process.env.ENVELOPE ?? "0";
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
