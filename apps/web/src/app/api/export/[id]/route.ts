// A budget's payments as a CSV file, for bookkeeping. Reads every request with `list_requests`
// (100 per page) and, where the history API has it, the transaction of each payment.
// Read-only, public data.
import { txUrl } from "@/lib/config";
import { STATUS } from "@/lib/format";
import { allContractEvents, getBudget, getToken, listRequests } from "@/lib/near";
import { exactUnits } from "@/lib/token";
import type { SpendRequest } from "@/lib/types";
import { toCsv } from "./csv";

export const dynamic = "force-dynamic";

const PAGE = 100;
/** 10,000 rows is far more than a budget has; it only stops a runaway loop. */
const MAX_PAGES = 100;
/** Transaction hashes are extra detail: the file goes out without them after this long. */
const TX_WAIT_MS = 8000;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d{1,20}$/.test(id)) return new Response("Not found", { status: 404 });
  const budget = await getBudget(id).catch(() => undefined);
  if (budget === null) return new Response("Not found", { status: 404 });
  if (!budget) return new Response("The contract can’t be reached. Try again.", { status: 503 });

  try {
    const [meta, requests, txs] = await Promise.all([
      getToken(budget.token_id),
      readAll(id),
      txByRequest(),
    ]);
    const rows = requests.map(([rid, r]) => {
      const tx = txs.get(rid) ?? "";
      return [
        new Date(Number(BigInt(r.created_at_ns) / 1_000_000n)).toISOString(),
        rid,
        r.payee,
        exactUnits(r.amount, meta.decimals),
        meta.symbol,
        STATUS[r.status]?.label ?? r.status,
        r.work_ref,
        tx,
        tx ? txUrl(tx) : "",
      ];
    });
    const csv = toCsv([
      [
        "date_utc",
        "request_id",
        "payee",
        "amount",
        "token",
        "status",
        "work_link",
        "tx_hash",
        "explorer_link",
      ],
      ...rows,
    ]);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="earmark-budget-${id}-payments.csv"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("The contract can’t be reached. Try again.", { status: 503 });
  }
}

/** Every request of the budget, newest first. */
async function readAll(budget: string): Promise<[string, SpendRequest][]> {
  const out: [string, SpendRequest][] = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await listRequests(budget, { from: out.length, limit: PAGE });
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

/** request id -> the transaction that paid it (or its latest one). Empty if history is down. */
async function txByRequest(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), TX_WAIT_MS));
  const events = await Promise.race([allContractEvents().catch(() => null), timeout]);
  for (const e of events ?? []) {
    const rid = e.data.request_id;
    if (typeof rid !== "string") continue;
    // Newest first: the first event seen is the latest; a payment's own transaction wins.
    if (!out.has(rid) || e.event === "spend_paid") out.set(rid, e.tx);
  }
  return out;
}
