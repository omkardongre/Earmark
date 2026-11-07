"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CONTRACT } from "@/lib/config";
import { ago, money, STATUS, shortName } from "@/lib/format";
import { view } from "@/lib/near";
import type { RequestStatus, SpendRequest, TokenMeta } from "@/lib/types";
import { Avatar, Card, Empty, Pill } from "./ui";
import { CHANGED } from "./wallet";

const PAGE = 10;
type Filter = "all" | "waiting" | "paid";
const WAITING: RequestStatus[] = ["pending_approval", "escalating", "escalated", "paying"];
const FILTERS: { key: Filter; label: string; match: (s: RequestStatus) => boolean }[] = [
  { key: "all", label: "All", match: () => true },
  { key: "waiting", label: "Waiting", match: (s) => WAITING.includes(s) },
  { key: "paid", label: "Paid", match: (s) => s === "paid" || s === "paid_by_dao" },
];

/**
 * A budget's payments, newest first: a table on desktop, rows on a phone. Starts with 10;
 * "Show more" reads the next page from the contract (`list_requests`).
 */
export function PaymentsTable({
  budgetId,
  first,
  total,
  meta,
}: {
  budgetId: string;
  first: [string, SpendRequest][];
  total: number;
  meta: TokenMeta;
}) {
  const [rows, setRows] = useState(first);
  const [count, setCount] = useState(total);
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const match = FILTERS.find((f) => f.key === filter)?.match ?? (() => true);
  const visible = rows.filter(([, r]) => match(r.status));
  const hasMore = rows.length < count;

  const page = useCallback(
    (from: number) =>
      view<[string, SpendRequest][]>(CONTRACT, "list_requests", {
        envelope_id: budgetId,
        from_index: String(from),
        limit: PAGE,
      }),
    [budgetId],
  );

  // After an action, re-read the newest page: new payments go on top, changed statuses update.
  useEffect(() => {
    const onChange = async () => {
      try {
        const [fresh, b] = await Promise.all([
          page(0),
          view<{ request_count: string } | null>(CONTRACT, "get_envelope", {
            envelope_id: budgetId,
          }),
        ]);
        setRows((xs) => {
          const ids = new Set(fresh.map(([id]) => id));
          return [...fresh, ...xs.filter(([id]) => !ids.has(id))];
        });
        if (b) setCount(Number(b.request_count));
      } catch {
        // Keep what we have.
      }
    };
    window.addEventListener(CHANGED, onChange);
    return () => window.removeEventListener(CHANGED, onChange);
  }, [page, budgetId]);

  const more = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const older = await page(rows.length);
      setRows((xs) => {
        const ids = new Set(xs.map(([id]) => id));
        return [...xs, ...older.filter(([id]) => !ids.has(id))];
      });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  if (count === 0) return <Empty>No payments yet.</Empty>;

  return (
    <div className="space-y-3">
      <fieldset className="flex gap-1.5">
        <legend className="sr-only">Filter payments</legend>
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
            className={`rounded-full px-3.5 py-1.5 text-sm font-medium ring-1 ring-inset ${
              filter === f.key
                ? "bg-ink text-white ring-ink"
                : "bg-white text-muted ring-line hover:text-ink"
            }`}
          >
            {f.label}
          </button>
        ))}
      </fieldset>
      <Card>
        <div className="hidden grid-cols-[1fr_7rem_8rem_8.5rem] gap-4 border-b border-line px-5 py-2.5 text-sm font-medium text-muted sm:grid">
          <span>Payee</span>
          <span>When</span>
          <span className="text-right">Amount</span>
          <span className="text-right">Status</span>
        </div>
        {visible.length === 0 ? (
          <p className="px-5 py-8 text-center text-muted">
            None {hasMore ? "in the payments loaded so far" : "here"}.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {visible.map(([id, r]) => {
              const s = STATUS[r.status];
              return (
                <li key={id}>
                  <Link
                    href={`/payments/${id}`}
                    className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-5 py-3.5 hover:bg-slate-50 sm:grid-cols-[1fr_7rem_8rem_8.5rem]"
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <Avatar id={r.payee} />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{shortName(r.payee)}</span>
                        <span className="block truncate text-sm text-muted">
                          by {shortName(r.spender)}
                          <span className="sm:hidden"> · {ago(r.created_at_ns)}</span>
                        </span>
                      </span>
                    </span>
                    <span className="hidden text-sm text-muted sm:block">
                      {ago(r.created_at_ns)}
                    </span>
                    <span className="tabular text-right font-semibold">
                      {money(r.amount, meta)}
                    </span>
                    <span className="col-start-2 text-right sm:col-start-auto">
                      <Pill tone={s.tone}>{s.label}</Pill>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        {hasMore && (
          <div className="border-t border-line p-2 text-center">
            <button
              type="button"
              onClick={more}
              disabled={busy}
              className="rounded-lg px-4 py-2 text-[15px] font-semibold text-brand hover:bg-brand-soft disabled:opacity-50"
            >
              {busy ? "Loading…" : failed ? "Couldn’t load. Try again" : "Show more"}
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}
