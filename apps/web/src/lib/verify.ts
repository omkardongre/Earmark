// The Verify page's checks: the same public reads `make verify` does (scripts/verify/verify.ts),
// run on the server with no keys. Each check becomes one row: pass/fail, one sentence, evidence.
import {
  accountUrl,
  CONTRACT,
  EXPECTED_CODE_HASH,
  EXPECTED_DAO,
  EXPLORER,
  proposalUrl,
  SOURCE_REPO,
  txUrl,
} from "./config";
import { money } from "./format";
import { accessKeyList, getToken, type Read, txApiRead, viewAccount, viewRead } from "./near";
import type { Budget, Config, SpendRequest } from "./types";

export type Evidence = { label: string; href: string };
export type CheckRow = {
  id: "keys" | "code" | "upgrades" | "owner" | "balances";
  title: string;
  ok: boolean;
  detail: string;
  evidence: Evidence[];
};
export type VerifyReport = {
  contract: string;
  checks: CheckRow[];
  /** When the checks ran (ms). */
  checkedAt: number;
  /** Set when some reads fell back to remembered values: when those were read live (ms). */
  staleFrom: number | null;
};

type SourceMetadata = {
  version?: string;
  link?: string;
  build_info?: {
    build_environment?: string;
    build_command?: string[];
    source_code_snapshot?: string;
    contract_path?: string;
  } | null;
};
type Proposal = { id: number; status: string; kind: Record<string, unknown> };
type AccountTxs = {
  account_txs: { transaction_hash: string; tx_block_timestamp: string }[];
  resume_token?: string;
};
type TxDetail = {
  transaction: { hash: string; signer_id: string; receiver_id: string; actions: unknown[] };
};

/** Raw RPC answer for a check, served by /verify/rpc/[check]. */
const rpcLink = (check: string, label = "RPC answer"): Evidence => ({
  label,
  href: `/verify/rpc/${check}`,
});
const short = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Runs one check; a failed read becomes a failed row instead of a broken page. */
async function guard(
  row: Pick<CheckRow, "id" | "title">,
  run: () => Promise<Omit<CheckRow, "id" | "title">>,
): Promise<CheckRow> {
  try {
    return { ...row, ...(await run()) };
  } catch (e) {
    return {
      ...row,
      ok: false,
      detail: `Couldn't read this from the chain right now (${errText(e)}). Try again in a minute.`,
      evidence: [{ label: "Contract on NearBlocks", href: accountUrl(CONTRACT) }],
    };
  }
}

/** Every DAO proposal, oldest first (Sputnik pages by id). Capped so a huge DAO can't stall. */
async function daoProposals(dao: string, track: (r: Read<unknown>) => void): Promise<Proposal[]> {
  const out: Proposal[] = [];
  for (let from = 0; from < 5000; from += 100) {
    const page = await viewRead<Proposal[]>(dao, "get_proposals", { from_index: from, limit: 100 });
    track(page);
    out.push(...page.value);
    if (page.value.length < 100) break;
  }
  return out;
}

/** Transactions the contract account signed itself (only possible while it had a key). */
async function selfSigned(track: (r: Read<unknown>) => void): Promise<TxDetail[]> {
  const hashes: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 5; i++) {
    const page = await txApiRead<AccountTxs>("/v0/account", {
      account_id: CONTRACT,
      is_signer: true,
      limit: 200,
      ...(cursor ? { resume_token: cursor } : {}),
    });
    track(page);
    hashes.push(...page.value.account_txs.map((t) => t.transaction_hash));
    if (!page.value.resume_token) break;
    cursor = page.value.resume_token;
  }
  const out: TxDetail[] = [];
  const unique = [...new Set(hashes)];
  for (let i = 0; i < unique.length; i += 20) {
    const r = await txApiRead<{ transactions: TxDetail[] }>("/v0/transactions", {
      tx_hashes: unique.slice(i, i + 20),
    });
    track(r);
    out.push(...r.value.transactions.filter((t) => t.transaction.signer_id === CONTRACT));
  }
  return out;
}

const hasAction = (t: TxDetail, name: string) =>
  t.transaction.actions.some((a) => typeof a === "object" && a !== null && name in a);

export async function runVerify(): Promise<VerifyReport> {
  let staleFrom: number | null = null;
  const track = (r: Read<unknown>) => {
    if (r.stale) staleFrom = staleFrom === null ? r.at : Math.min(staleFrom, r.at);
  };
  const tracked = async <T>(p: Promise<Read<T>>): Promise<T> => {
    const r = await p;
    track(r);
    return r.value;
  };

  const keysP = tracked(accessKeyList(CONTRACT)).then((r) => r.keys);
  // Checks that need the key count still run if that read fails.
  const keysOrNull = keysP.catch(() => null);

  const keys = guard({ id: "keys", title: "No one holds a key to the contract" }, async () => {
    const list = await keysP;
    const full = list.filter((k) => k.access_key.permission === "FullAccess").length;
    return {
      ok: list.length === 0,
      detail:
        list.length === 0
          ? `${CONTRACT} has 0 access keys, so no person, not even us, can sign for it.`
          : `${CONTRACT} has ${list.length} access key${list.length === 1 ? "" : "s"} (${full} full access). Someone could sign for it.`,
      evidence: [
        { label: "Keys on NearBlocks", href: `${accountUrl(CONTRACT)}?tab=accesskeys` },
        rpcLink("keys"),
      ],
    };
  });

  const code = guard({ id: "code", title: "The code is the published build" }, async () => {
    const [account, meta] = await Promise.all([
      tracked(viewAccount(CONTRACT)),
      tracked(viewRead<SourceMetadata>(CONTRACT, "contract_source_metadata")),
    ]);
    const snapshot = meta.build_info?.source_code_snapshot ?? "";
    const rev =
      /[?&]rev=([0-9a-f]{7,40})/.exec(snapshot)?.[1] ??
      /tree\/([0-9a-f]{7,40})/.exec(meta.link ?? "")?.[1];
    const match = account.code_hash === EXPECTED_CODE_HASH;
    // `cargo near build reproducible-wasm` runs the build inside an image pinned by digest and
    // records that image here (the command it records is the one run inside the container).
    const reproducible = /@sha256:[0-9a-f]{64}$/.test(meta.build_info?.build_environment ?? "");
    const parts = [
      match
        ? `Code hash ${short(account.code_hash)} matches the build recorded for this release.`
        : `Code hash ${short(account.code_hash)} isn't the recorded build ${short(EXPECTED_CODE_HASH)}.`,
      rev
        ? `The contract names its source: commit ${rev.slice(0, 7)}.`
        : "The contract doesn't name its source commit.",
    ];
    parts.push(
      reproducible
        ? "It was built in a pinned Docker image, so anyone can rebuild the same bytes."
        : "This build isn't reproducible yet.",
    );
    return {
      ok: match && Boolean(rev),
      detail: parts.join(" "),
      evidence: [
        ...(rev
          ? [{ label: `Source at ${rev.slice(0, 7)}`, href: `${SOURCE_REPO}/tree/${rev}` }]
          : []),
        { label: "Contract on NearBlocks", href: accountUrl(CONTRACT) },
        rpcLink("code"),
      ],
    };
  });

  const config = tracked(viewRead<Config>(CONTRACT, "get_config"));
  const dao = config.then((c) => c.dao_id).catch(() => EXPECTED_DAO);

  const owner = guard({ id: "owner", title: "The DAO is the owner" }, async () => {
    const c = await config;
    const ok = c.dao_id === EXPECTED_DAO;
    return {
      ok,
      detail: ok
        ? `Only ${c.dao_id} can create budgets, change rules or install new code.`
        : `The contract answers to ${c.dao_id}, not ${EXPECTED_DAO}.`,
      evidence: [{ label: "DAO on NearBlocks", href: accountUrl(c.dao_id) }, rpcLink("owner")],
    };
  });

  const upgrades = guard({ id: "upgrades", title: "Code changes only by DAO vote" }, async () => {
    const [list, mine, k, daoId] = await Promise.all([
      daoProposals(await dao, track),
      selfSigned(track),
      keysOrNull,
      dao,
    ]);
    const votes = list.filter((p) => {
      const u = p.kind.UpgradeRemote as { receiver_id?: string } | undefined;
      return u?.receiver_id === CONTRACT;
    });
    const passed = votes.filter((p) => p.status === "Approved");
    const deploys = mine.filter((t) => hasAction(t, "DeployContract"));
    const deploy = deploys[0];
    const keyGone = mine.find((t) => hasAction(t, "DeleteKey"));
    const ok = k !== null && k.length === 0;
    const times = deploys.length === 1 ? "once" : `${deploys.length} times`;
    const history =
      deploy && keyGone
        ? `Deployed ${times} with its own key, then that key was deleted.`
        : "The contract has no key left to deploy code with.";
    const tally =
      passed.length === 0
        ? "Since then, only a DAO vote can install new code: none so far."
        : `Since then, code changed only by DAO vote${passed.length === 1 ? "" : "s"} ${passed.map((p) => `#${p.id}`).join(" and ")}.`;
    return {
      ok,
      detail: ok
        ? `${history} ${tally}`
        : "The contract still has an access key, so code could change without a vote.",
      evidence: [
        ...passed.map((p) => ({ label: `DAO vote #${p.id}`, href: proposalUrl(daoId, p.id) })),
        ...(deploy ? [{ label: "Deploy", href: txUrl(deploy.transaction.hash) }] : []),
        ...(keyGone ? [{ label: "Key deleted", href: txUrl(keyGone.transaction.hash) }] : []),
        rpcLink("upgrades", "DAO proposals"),
      ],
    };
  });

  const balances = guard({ id: "balances", title: "Balances add up" }, async () => {
    const budgets = await tracked(viewRead<Budget[]>(CONTRACT, "list_envelopes", {}));
    const tokens = [...new Set(budgets.map((b) => b.token_id))];
    const problems: string[] = [];
    const sentences: string[] = [];
    for (const token of tokens) {
      const mine = budgets.filter((b) => b.token_id === token);
      const [meta, held] = await Promise.all([
        getToken(token),
        tracked(viewRead<string>(token, "ft_balance_of", { account_id: CONTRACT })),
      ]);
      const sum = (f: (b: Budget) => string) => mine.reduce((s, b) => s + BigInt(f(b)), 0n);
      const [bal, avail, waiting, spent] = [
        sum((b) => b.balance),
        sum((b) => b.available),
        sum((b) => (BigInt(b.committed) + BigInt(b.in_flight)).toString()),
        sum((b) => b.spent_total),
      ];
      for (const b of mine) {
        if (BigInt(b.balance) !== BigInt(b.available) + BigInt(b.committed) + BigInt(b.in_flight))
          problems.push(`${b.name}: balance isn't available + waiting`);
        const requests = await allRequests(b.id, track);
        if (requests.length !== Number(b.request_count))
          problems.push(`${b.name}: ${requests.length} of ${b.request_count} requests readable`);
        const paid = requests
          .filter(([, r]) => r.status === "paid")
          .reduce((s, [, r]) => s + BigInt(r.amount), 0n);
        if (paid !== BigInt(b.spent_total)) problems.push(`${b.name}: paid requests ≠ paid out`);
      }
      if (BigInt(held) < bal)
        problems.push(`holds ${money(held, meta)}, budgets need ${money(bal, meta)}`);
      sentences.push(
        `The contract holds ${money(held, meta)}: ${money(avail, meta)} available and ${money(waiting, meta)} waiting for approval. Paid requests add up to the ${money(spent, meta)} paid out.`,
      );
    }
    return {
      ok: problems.length === 0,
      detail:
        problems.length === 0 ? sentences.join(" ") : `Doesn't add up: ${problems.join("; ")}.`,
      evidence: [
        ...tokens.map((t) => ({
          label: "Token balance",
          href: `${EXPLORER}/token/${t}?a=${CONTRACT}`,
        })),
        rpcLink("balances"),
      ],
    };
  });

  const checks = await Promise.all([keys, code, upgrades, owner, balances]);
  return { contract: CONTRACT, checks, checkedAt: Date.now(), staleFrom };
}

async function allRequests(
  budget: string,
  track: (r: Read<unknown>) => void,
): Promise<[string, SpendRequest][]> {
  const out: [string, SpendRequest][] = [];
  for (let from = 0; from < 10_000; from += 100) {
    const page = await viewRead<[string, SpendRequest][]>(CONTRACT, "list_requests", {
      envelope_id: budget,
      from_index: String(from),
      limit: 100,
    });
    track(page);
    out.push(...page.value);
    if (page.value.length < 100) break;
  }
  return out;
}

// Short revalidation: one run serves every visitor for 30 s, and visitors arriving while a run
// is in flight share it.
const FRESH_MS = 30_000;
const g = globalThis as { __earmarkVerify?: { at: number; run: Promise<VerifyReport> } };

export function getVerifyReport(): Promise<VerifyReport> {
  const now = Date.now();
  const hit = g.__earmarkVerify;
  if (hit && now - hit.at < FRESH_MS) return hit.run;
  const run = runVerify();
  g.__earmarkVerify = { at: now, run };
  // A failed run isn't kept.
  run.catch(() => {
    if (g.__earmarkVerify?.run === run) delete g.__earmarkVerify;
  });
  return run;
}
