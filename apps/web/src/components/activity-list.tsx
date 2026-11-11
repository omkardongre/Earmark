"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Activity } from "@/lib/activity";
import { txUrl } from "@/lib/config";
import type { ActivityPage } from "@/lib/data";
import { ago } from "@/lib/format";
import { Card, Empty, Pill } from "./ui";
import { CHANGED } from "./wallet";

const PAGE = 10;

/** One row per event, keeping the first: refreshed and older pages can overlap. */
const unique = (rows: Activity[]) => {
  const seen = new Set<string>();
  return rows.filter((a) => !seen.has(a.key) && seen.add(a.key));
};

/** The feed: 10 rows, then "Show more" shows the next loaded rows or fetches older history. */
export function ActivityList({
  first,
  budget,
  account,
  skipPayments = false,
  skipChanges = false,
  pageSize = PAGE,
  empty = "No activity yet.",
}: {
  first: ActivityPage;
  budget?: string;
  account?: string;
  /** Leave out payment rows (the budget page lists payments in their own table). */
  skipPayments?: boolean;
  /** Leave out rule changes (the home feed shows money only). */
  skipChanges?: boolean;
  /** Rows shown at first and per "Show more". */
  pageSize?: number;
  empty?: React.ReactNode;
}) {
  const [items, setItems] = useState(first.items);
  const [next, setNext] = useState(first.next);
  const [shown, setShown] = useState(pageSize);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const fetchPage = useCallback(
    async (cursor?: string) => {
      const q = new URLSearchParams();
      if (cursor) q.set("cursor", cursor);
      if (budget !== undefined) q.set("budget", budget);
      if (account !== undefined) q.set("account", account);
      if (skipPayments) q.set("skip", "payments");
      else if (skipChanges) q.set("skip", "changes");
      const res = await fetch(`/api/activity?${q}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as ActivityPage;
    },
    [budget, account, skipPayments, skipChanges],
  );

  // After the user's own action, put the newest rows on top without losing what's loaded below.
  useEffect(() => {
    const onChange = async () => {
      try {
        const page = await fetchPage();
        if (!page.loaded) return;
        setItems((xs) => unique([...page.items, ...xs]));
      } catch {
        // Keep the rows we have; the next change or a reload catches up.
      }
    };
    window.addEventListener(CHANGED, onChange);
    return () => window.removeEventListener(CHANGED, onChange);
  }, [fetchPage]);

  // The history API sometimes fails once and works a moment later: try once more by itself.
  const [retrying, setRetrying] = useState(!first.loaded);
  useEffect(() => {
    if (!retrying) return;
    const t = setTimeout(async () => {
      try {
        const page = await fetchPage();
        if (page.loaded) {
          setItems(page.items);
          setNext(page.next);
        }
      } catch {
        // Fall through to the message below.
      }
      setRetrying(false);
    }, 1500);
    return () => clearTimeout(t);
  }, [retrying, fetchPage]);

  if (retrying && items.length === 0) return <Empty>Loading activity…</Empty>;
  if (!first.loaded && items.length === 0)
    return <Empty>Activity can’t be loaded right now. The numbers above are live.</Empty>;
  if (items.length === 0 && !next) return <Empty>{empty}</Empty>;

  const more = async () => {
    if (shown < items.length) {
      setShown((n) => n + pageSize);
      return;
    }
    if (!next) return;
    setBusy(true);
    setFailed(false);
    try {
      const page = await fetchPage(next);
      setItems((xs) => unique([...xs, ...page.items]));
      setNext(page.next);
      setShown((n) => n + pageSize);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <ul className="divide-y divide-line">
        {items.slice(0, shown).map((a) => (
          <li key={a.key}>
            <Row a={a} />
          </li>
        ))}
      </ul>
      {(shown < items.length || next) && (
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
  );
}

function Row({ a }: { a: Activity }) {
  const body = (
    <>
      <span className="min-w-0">
        <span className="block">{a.text}</span>
        <span className="block text-sm text-muted">{ago(a.timestampNs)}</span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        {a.amount && <span className="tabular font-semibold">{a.amount}</span>}
        {a.chip && <Pill tone={a.chip.tone}>{a.chip.label}</Pill>}
      </span>
    </>
  );
  const cls = "flex items-center justify-between gap-4 px-5 py-3.5 hover:bg-slate-50";
  const page = a.requestId ? `/payments/${a.requestId}` : a.href;
  return page ? (
    <Link href={page} className={cls}>
      {body}
    </Link>
  ) : (
    <a
      href={txUrl(a.tx)}
      target="_blank"
      rel="noreferrer"
      className={cls}
      title="Open the transaction"
    >
      {body}
    </a>
  );
}
