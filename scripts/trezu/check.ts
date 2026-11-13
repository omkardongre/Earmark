// `make trezu-check`: checks the Trezu forms in trezu/*.json two ways.
// 1. Trezu's own manifest validator (`parseManifest` from NEAR-DevHub/trezu, fetched at a pinned
//    commit, not copied into this repo), so Trezu will accept each form as written.
// 2. The call each form builds, filled with sample values, has the exact argument shape the
//    Earmark contract method expects, so a council's proposal won't fail at execution.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TREZU_COMMIT = "62cf0e41d4b2d2358a496d47c80fcd2e59094247";
const SOURCE = `https://raw.githubusercontent.com/NEAR-DevHub/trezu/${TREZU_COMMIT}/nt-fe/features/proposal-templates/manifest.ts`;
const CONTRACT = "budgets.omkar5.near";
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
/** Trezu votes with 75 Tgas; the call must leave room for the vote itself. */
const MAX_GAS = 50n * 10n ** 12n;

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

type Field = { name: string; type: string };
type Manifest = {
  id: string;
  binding: { receiver_id: string; method_name: string; deposit: string; gas: string };
  fields: Field[];
  args: Record<string, unknown>;
};

// Trezu's validator, cached next to this script so it resolves `zod` from scripts/node_modules.
const cache = resolve(here, ".cache/manifest.ts");
mkdirSync(dirname(cache), { recursive: true });
const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`fetch Trezu validator: ${res.status}`);
writeFileSync(cache, await res.text());
const { parseManifest } = (await import(pathToFileURL(cache).href)) as {
  parseManifest: (m: unknown) => {
    success: boolean;
    error?: { issues: { path: unknown[]; message: string }[] };
  };
};

const SAMPLE: Record<string, string> = {
  account: "alice.near",
  amount: "1000000",
  uint: "0",
  text: "Content Q1",
};
/** Trezu substitutes {{name}} inside string values only (no bool/number/json fields here). */
function fill(v: unknown, values: Record<string, string>): unknown {
  if (typeof v === "string") return v.replace(/\{\{(\w+)\}\}/g, (_, n: string) => values[n] ?? "");
  if (Array.isArray(v)) return v.map((x) => fill(x, values));
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, values)]));
  return v;
}

const keys = (o: unknown) => Object.keys((o ?? {}) as object).sort();
const digits = (s: unknown) => typeof s === "string" && /^\d+$/.test(s);
const account = (s: unknown) => typeof s === "string" && /^[a-z\d._-]{2,64}$/.test(s);

/** Exact argument shapes of the contract methods (contracts/earmark/src). Returns problems. */
function shape(m: Manifest, a: Record<string, unknown>): string[] {
  const p: string[] = [];
  const need = (ok: boolean, what: string) => ok || p.push(what);
  const { receiver_id: to, method_name: method } = m.binding;
  switch (method) {
    case "create_envelope": {
      need(to === CONTRACT, "receiver is the Earmark contract");
      const e = a.envelope as Record<string, unknown>;
      need(
        keys(e).join() ===
          "approvers,name,one_approver_limit,payees,pending_ttl_secs,period_cap,period_secs,raise_ceiling,spenders,token_id",
        "envelope has exactly the EnvelopeInput fields",
      );
      need(e.token_id === USDC, "budget token is native USDC");
      const s = (e.spenders as Record<string, unknown>[])[0];
      need(keys(s).join() === "account_id,auto_limit,period_cap", "spender shape");
      need(
        account(s?.account_id) && digits(s?.auto_limit) && digits(s?.period_cap),
        "spender values",
      );
      for (const k of ["one_approver_limit", "raise_ceiling", "period_cap", "period_secs"])
        need(digits(e[k]), `${k} is a digit string`);
      need((e.approvers as unknown[]).every(account), "approvers are accounts");
      need((e.payees as unknown[]).every(account), "payees are accounts");
      break;
    }
    case "ft_transfer_call": {
      need(to === USDC, "receiver is the USDC token");
      need(m.binding.deposit === "1", "1 yoctoNEAR attached (NEP-141)");
      need(keys(a).join() === "amount,msg,receiver_id" && a.receiver_id === CONTRACT, "args");
      const msg = JSON.parse(String(a.msg)) as Record<string, unknown>;
      need(keys(msg).join() === "envelope_id" && digits(msg.envelope_id), "msg names the budget");
      break;
    }
    case "update_envelope": {
      need(to === CONTRACT, "receiver is the Earmark contract");
      need(keys(a).join() === "changes,envelope_id" && digits(a.envelope_id), "args");
      const [c] = a.changes as Record<string, Record<string, unknown>>[];
      const lim = c?.spender_auto_limit;
      need(keys(c).join() === "spender_auto_limit" && account(lim?.spender), "change kind");
      need(digits(lim?.amount), "amount is a digit string");
      break;
    }
    case "approve_payee":
      need(keys(a).join() === "envelope_id,payee" && account(a.payee), "args");
      break;
    case "pause":
      need(keys(a).join() === "envelope_id,spender" && a.spender === null, "whole budget");
      break;
    case "close_envelope":
      need(keys(a).join() === "envelope_id" && digits(a.envelope_id), "args");
      break;
    default:
      p.push(`unknown method ${method}`);
  }
  if (method !== "ft_transfer_call") need(to === CONTRACT, "receiver is the Earmark contract");
  need(BigInt(m.binding.gas) <= MAX_GAS, "gas at most 50 Tgas");
  return p;
}

const dir = resolve(root, "trezu");
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
let failed = 0;
for (const f of files) {
  const m = JSON.parse(readFileSync(resolve(dir, f), "utf8")) as Manifest;
  const parsed = parseManifest(m);
  const trezu = parsed.success
    ? []
    : (parsed.error?.issues ?? []).map((i) => `${i.path.join(".")}: ${i.message}`);
  const values = Object.fromEntries(m.fields.map((x) => [x.name, SAMPLE[x.type] ?? "x"]));
  const problems = [...trezu, ...shape(m, fill(m.args, values) as Record<string, unknown>)];
  if (f !== `${m.id}.json`) problems.push("file name is the template id");
  if (problems.length) failed++;
  console.log(
    `${problems.length ? "FAIL" : "PASS"}  ${m.id}${problems.length ? `: ${problems.join("; ")}` : ""}`,
  );
}
console.log(
  `\n${files.length - failed} of ${files.length} forms pass Trezu's validator and the contract's shapes.`,
);
process.exit(failed ? 1 : 0);
