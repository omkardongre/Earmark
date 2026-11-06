// Past Transfer proposals of a Sputnik DAO on mainnet, in a compact form the preview replays
// against draft rules in the browser. Read-only public RPC; cached in memory for an hour.
import { NextResponse } from "next/server";

const RPC = process.env.PREVIEW_RPC_URL ?? "https://free.rpc.fastnear.com";
const PAGE = 200;
const MAX_PROPOSALS = 30_000;
const TTL_MS = 60 * 60 * 1000;
const TRACKING = new Set([
  "t",
  "s",
  "si",
  "ref",
  "ref_src",
  "feature",
  "usp",
  "ouid",
  "rtpof",
  "sd",
  "fbclid",
  "igshid",
]);
const DAO_RE = /^[a-z0-9][a-z0-9_-]{0,48}\.sputnik-dao\.near$/;

type Proposal = {
  id: number;
  proposer: string;
  description: string;
  kind: { Transfer?: { token_id: string; receiver_id: string; amount: string } } | string;
  status: string;
  submission_time: string;
};

export type PreviewData = {
  dao: string;
  total: number;
  tokens: { id: string; symbol: string; decimals: number }[];
  receivers: string[];
  /** [proposal id, token index, amount, receiver index, status, work key or "", submission ms] */
  transfers: [number, number, string, number, string, string, number][];
  fetchedAt: number;
};

const cache = new Map<string, { at: number; data: Promise<PreviewData> }>();

async function view<T>(account: string, method: string, args: object): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: account,
          method_name: method,
          args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
        },
      }),
      cache: "no-store",
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    const body = (await res.json()) as {
      result?: { result?: number[]; error?: string };
      error?: { cause?: { name?: string } };
    };
    if (body.error) throw new Error(body.error.cause?.name ?? "rpc_error");
    if (!body.result?.result) throw new Error(body.result?.error ?? "view_failed");
    return JSON.parse(Buffer.from(body.result.result).toString()) as T;
  }
}

/** First link in the description without query or fragment: the "work" a payout is for (R16). */
function workKey(description: string): string {
  const m = description.match(/https?:\/\/[^\s$<>"')\]]+/i);
  if (!m) return "";
  try {
    const u = new URL(m[0]);
    // Share links differ only in tracking parameters; the rest (e.g. YouTube's ?v=) names the work.
    const kept = [...u.searchParams.entries()]
      .filter(([k]) => !TRACKING.has(k) && !k.startsWith("utm_"))
      .sort(([a], [b]) => a.localeCompare(b));
    const query = kept.length ? `?${new URLSearchParams(kept).toString()}` : "";
    return `${u.hostname.replace(/^(www|mobile|m)\./, "").toLowerCase()}${u.pathname.replace(/\/+$/, "")}${query}`;
  } catch {
    return "";
  }
}

async function load(dao: string): Promise<PreviewData> {
  const last = await view<number>(dao, "get_last_proposal_id", {});
  const total = Math.min(last, MAX_PROPOSALS);
  const starts = Array.from({ length: Math.ceil(total / PAGE) }, (_, i) => i * PAGE);
  const pages: Proposal[][] = [];
  for (let i = 0; i < starts.length; i += 4) {
    pages.push(
      ...(await Promise.all(
        starts
          .slice(i, i + 4)
          .map((from) => view<Proposal[]>(dao, "get_proposals", { from_index: from, limit: PAGE })),
      )),
    );
  }
  const tokenIdx = new Map<string, number>();
  const receiverIdx = new Map<string, number>();
  const transfers: PreviewData["transfers"] = [];
  for (const p of pages.flat()) {
    const t = typeof p.kind === "object" ? p.kind.Transfer : undefined;
    if (!t) continue;
    if (!tokenIdx.has(t.token_id)) tokenIdx.set(t.token_id, tokenIdx.size);
    if (!receiverIdx.has(t.receiver_id)) receiverIdx.set(t.receiver_id, receiverIdx.size);
    transfers.push([
      p.id,
      tokenIdx.get(t.token_id) as number,
      t.amount,
      receiverIdx.get(t.receiver_id) as number,
      p.status,
      workKey(p.description),
      Math.floor(Number(BigInt(p.submission_time) / 1_000_000n)),
    ]);
  }
  const tokens = await Promise.all(
    [...tokenIdx.keys()].map(async (id) => {
      if (id === "") return { id, symbol: "NEAR", decimals: 24 };
      try {
        const m = await view<{ symbol: string; decimals: number }>(id, "ft_metadata", {});
        return { id, symbol: m.symbol, decimals: m.decimals };
      } catch {
        return { id, symbol: id.slice(0, 10), decimals: 0 };
      }
    }),
  );
  return {
    dao,
    total: last,
    tokens,
    receivers: [...receiverIdx.keys()],
    transfers,
    fetchedAt: Date.now(),
  };
}

export async function GET(req: Request) {
  const dao = new URL(req.url).searchParams.get("dao")?.trim().toLowerCase() ?? "";
  if (!DAO_RE.test(dao)) {
    return NextResponse.json(
      { error: "Enter a DAO account, like name.sputnik-dao.near" },
      { status: 400 },
    );
  }
  let entry = cache.get(dao);
  if (!entry || Date.now() - entry.at > TTL_MS) {
    entry = { at: Date.now(), data: load(dao) };
    cache.set(dao, entry);
  }
  try {
    return NextResponse.json(await entry.data, {
      headers: { "Cache-Control": "public, max-age=600" },
    });
  } catch (e) {
    cache.delete(dao);
    const msg = String(e);
    const notFound = /UNKNOWN_ACCOUNT|CodeDoesNotExist|MethodNotFound/i.test(msg);
    return NextResponse.json(
      {
        error: notFound
          ? "No DAO found at that account."
          : "Couldn’t read the DAO’s history. Try again.",
      },
      { status: notFound ? 404 : 502 },
    );
  }
}
