// `make demo`: replays the recorded testnet demo from fixtures/ with no keys and no network.
// Each line is a step, the outcome it must have, what happened and its transaction. `make verify`
// checks the same transactions on-chain.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Step = {
  step: string;
  label: string;
  expect: string;
  tx?: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  available?: string;
};
type Fixture = {
  network: string;
  contract: string;
  dao: string;
  envelope_id: string;
  steps: Step[];
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fx = JSON.parse(readFileSync(resolve(root, "fixtures/testnet-demo.json"), "utf8")) as Fixture;
const explorer =
  fx.network === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";

console.log(
  `Earmark demo (recorded on ${fx.network}): contract ${fx.contract}, DAO ${fx.dao}, budget ${fx.envelope_id}\n`,
);
let mismatches = 0;
for (const s of fx.steps) {
  const outcome = s.ok
    ? `ok${typeof s.result === "string" ? ` ${s.result}` : ""}`
    : `rejected ${s.error}`;
  const match = outcome.startsWith(s.expect);
  if (!match) mismatches++;
  const left = s.available === undefined ? "" : `  available ${s.available}`;
  console.log(`${match ? "✓" : "✗"} ${s.label.padEnd(42)} ${outcome.padEnd(28)}${left}`);
  if (s.tx) console.log(`  ${explorer}/txns/${s.tx}`);
}
console.log(
  `\n${fx.steps.length} steps, ${mismatches} mismatches. Run \`make verify\` to check them on-chain.`,
);
process.exit(mismatches === 0 ? 0 : 1);
