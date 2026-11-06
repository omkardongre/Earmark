"use client";

import { useEffect, useMemo, useState } from "react";
import type { PreviewData } from "@/app/api/preview/route";
import { toBase, units } from "@/lib/format";
import { Button, Card, Disclosure, Pill, Skeleton } from "./ui";

type Path = "auto" | "one" | "dao" | "duplicate";
type Outcome = "approved" | "rejected" | "expired" | "other";

const PATHS: {
  key: Path;
  label: string;
  tone: "green" | "amber" | "blue" | "red";
  hint: string;
}[] = [
  { key: "auto", label: "Paid at once", tone: "green", hint: "within the limit" },
  { key: "one", label: "One approval", tone: "amber", hint: "one approver signs" },
  { key: "dao", label: "DAO vote", tone: "blue", hint: "the council votes" },
  { key: "duplicate", label: "Blocked", tone: "red", hint: "same work paid twice" },
];

const OUTCOMES: { key: Outcome; label: string }[] = [
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "expired", label: "Expired" },
  { key: "other", label: "Open or removed" },
];

const outcomeOf = (status: string): Outcome =>
  status === "Approved"
    ? "approved"
    : status === "Rejected"
      ? "rejected"
      : status === "Expired"
        ? "expired"
        : "other";

const PAGE = 10;
const n = (x: number) => x.toLocaleString("en-US");

/** "nearweek-news-contribution.sputnik-dao.near" -> "Nearweek News Contribution". */
const daoName = (id: string) =>
  (id.split(".")[0] ?? id)
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

function since(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

export function RulePreview({ defaultDao }: { defaultDao: string }) {
  const [dao, setDao] = useState(defaultDao);
  const [editing, setEditing] = useState(false);
  const [data, setData] = useState<PreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [token, setToken] = useState(0);
  const [auto, setAuto] = useState("1");
  const [one, setOne] = useState("5");
  const [filter, setFilter] = useState<Path | "all">("all");
  const [shown, setShown] = useState(PAGE);

  const load = async (account: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/preview?dao=${encodeURIComponent(account)}`);
      const body = (await res.json()) as PreviewData & { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Couldn’t load the DAO.");
      setData(body);
      setEditing(false);
      setShown(PAGE);
      const counts = body.tokens.map((_, i) => body.transfers.filter((t) => t[1] === i).length);
      setToken(counts.indexOf(Math.max(...counts)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once with the default DAO
  useEffect(() => {
    void load(defaultDao);
  }, []);

  const meta = data?.tokens[token];
  const autoBase = meta ? toBase(auto, meta) : null;
  const oneBase = meta ? toBase(one, meta) : null;
  const rulesOk = autoBase !== null && oneBase !== null && BigInt(autoBase) <= BigInt(oneBase);

  // Tokens the DAO actually paid out in, and typical amounts for the presets.
  const usedTokens = useMemo(
    () =>
      data
        ? data.tokens
            .map((t, i) => ({ ...t, i, count: data.transfers.filter((x) => x[1] === i).length }))
            .filter((t) => t.count > 0)
        : [],
    [data],
  );
  const presets = useMemo(() => {
    if (!data || !meta) return { auto: [], one: [] };
    const amounts = data.transfers
      .filter((t) => t[1] === token)
      .map((t) => BigInt(t[2]))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (amounts.length === 0) return { auto: [], one: [] };
    const at = (q: number) =>
      units(
        amounts[Math.min(amounts.length - 1, Math.floor(q * amounts.length))] ?? 0n,
        meta,
      ).replaceAll(",", "");
    // Usual payouts suit "paid at once"; the larger ones suit "one approval". Each amount shows
    // under one field only, so a DAO that always pays the same shows it once.
    const auto = [...new Set([at(0.5), at(0.9)])];
    const one = [...new Set([at(0.9), at(0.99)])].filter((v) => !auto.includes(v));
    return { auto, one };
  }, [data, meta, token]);

  const result = useMemo(() => {
    if (!data || !meta || !rulesOk || autoBase === null || oneBase === null) return null;
    const a = BigInt(autoBase);
    const o = BigInt(oneBase);
    const table: Record<Path, Record<Outcome, number>> = {
      auto: { approved: 0, rejected: 0, expired: 0, other: 0 },
      one: { approved: 0, rejected: 0, expired: 0, other: 0 },
      dao: { approved: 0, rejected: 0, expired: 0, other: 0 },
      duplicate: { approved: 0, rejected: 0, expired: 0, other: 0 },
    };
    const paidWork = new Set<string>();
    const rows: { id: number; amount: string; receiver: string; path: Path; status: string }[] = [];
    const list = data.transfers.filter((t) => t[1] === token).sort((x, y) => x[0] - y[0]);
    for (const [id, , amount, recv, status, work] of list) {
      const key = work ? `${recv}|${work}` : "";
      const v = BigInt(amount);
      const path: Path =
        key && paidWork.has(key) ? "duplicate" : v <= a ? "auto" : v <= o ? "one" : "dao";
      const outcome = outcomeOf(status);
      table[path][outcome]++;
      if (key && outcome === "approved") paidWork.add(key);
      rows.push({ id, amount, receiver: data.receivers[recv] ?? "", path, status });
    }
    const count = (p: Path) => Object.values(table[p]).reduce((s, x) => s + x, 0);
    return {
      table,
      total: list.length,
      count: {
        auto: count("auto"),
        one: count("one"),
        dao: count("dao"),
        duplicate: count("duplicate"),
      },
      rows: rows.reverse(),
    };
  }, [data, meta, token, autoBase, oneBase, rulesOk]);

  const input = "h-11.5 w-full min-w-0 bg-transparent px-3.5 outline-none tabular";
  const visible = result ? result.rows.filter((r) => filter === "all" || r.path === filter) : [];

  return (
    <div className="space-y-6">
      {/* Which DAO: NEARWEEK by default, another one on request. */}
      {editing || (!data && !loading) ? (
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            void load(dao);
          }}
        >
          <input
            className="h-11.5 w-full rounded-xl border border-slate-300 bg-white px-3.5 outline-none focus:border-brand focus:ring-4 focus:ring-brand/20"
            value={dao}
            onChange={(e) => setDao(e.target.value)}
            placeholder="name.sputnik-dao.near"
            autoCapitalize="none"
            spellCheck={false}
            aria-label="DAO account"
          />
          <Button type="submit" disabled={loading} className="shrink-0">
            {loading ? "Reading…" : "Load"}
          </Button>
          {data && (
            <Button variant="ghost" className="shrink-0" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          )}
        </form>
      ) : data ? (
        <p className="flex flex-wrap items-center gap-x-2 text-muted">
          <span className="font-semibold text-ink">{daoName(data.dao)}</span>
          <span>
            · {n(data.total)} proposals · read {since(data.fetchedAt)}
          </span>
          <button
            type="button"
            className="font-semibold text-brand hover:underline"
            onClick={() => setEditing(true)}
          >
            Use another DAO
          </button>
        </p>
      ) : null}

      {error && <p className="rounded-xl bg-rose-50 px-4 py-3 text-rose-700">{error}</p>}

      {loading && !data && (
        <div className="space-y-4" aria-busy="true">
          <p className="text-muted">
            Reading every past proposal of the DAO. Big DAOs take up to a minute the first time.
          </p>
          <div className="grid gap-4 sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Card key={i} className="space-y-3 p-5">
                <Skeleton className="h-5 w-20" />
                <Skeleton className="h-8 w-16" />
              </Card>
            ))}
          </div>
        </div>
      )}

      {data && meta && (
        <Card className="grid gap-5 p-5 sm:grid-cols-2">
          <LimitInput
            label="Paid at once up to"
            value={auto}
            onChange={setAuto}
            unit={meta.symbol}
            presets={presets.auto}
            className={input}
          />
          <LimitInput
            label="One approval up to"
            value={one}
            onChange={setOne}
            unit={meta.symbol}
            presets={presets.one}
            className={input}
          />
          {usedTokens.length > 1 && (
            <label className="space-y-1.5 sm:col-span-2">
              <span className="font-medium">Token</span>
              <select
                className="h-11.5 w-full rounded-xl border border-slate-300 bg-white px-3.5"
                value={token}
                onChange={(e) => setToken(Number(e.target.value))}
              >
                {usedTokens.map((t) => (
                  <option key={t.id || "near"} value={t.i}>
                    {t.symbol}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!rulesOk && (
            <p className="text-rose-700 sm:col-span-2">
              Use amounts, with the first limit no higher than the second.
            </p>
          )}
        </Card>
      )}

      {data && meta && result && (
        <div className="space-y-6">
          <div className="space-y-1">
            <p className="text-2xl font-semibold tracking-tight">
              Your council would vote on {n(result.count.dao)} of {n(result.total)} payouts.
            </p>
            <p className="text-muted">
              {n(result.count.auto)} would be paid at once and {n(result.count.one)} would need one
              approval. This shows which way each payout would go, not which ones deserved payment.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {PATHS.map((p) => (
              <Card key={p.key} className="space-y-2 p-5">
                <Pill tone={p.tone}>{p.label}</Pill>
                <p className="tabular text-3xl font-bold tracking-tight">
                  {n(result.count[p.key])}
                </p>
                <p className="text-sm text-muted">{p.hint}</p>
              </Card>
            ))}
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold tracking-tight">Payouts</h2>
              <fieldset className="flex flex-wrap gap-1.5">
                <legend className="sr-only">Filter payouts</legend>
                {[{ key: "all" as const, label: "All" }, ...PATHS].map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    aria-pressed={filter === f.key}
                    onClick={() => {
                      setFilter(f.key);
                      setShown(PAGE);
                    }}
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
            </div>
            <Card>
              {visible.length === 0 ? (
                <p className="px-5 py-8 text-center text-muted">None.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {visible.slice(0, shown).map((r) => {
                    const p = PATHS.find((x) => x.key === r.path);
                    return (
                      <li
                        key={r.id}
                        className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-5 py-3"
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{r.receiver}</span>
                          <span className="block text-sm text-muted">
                            #{r.id} · {councilDid(r.status)}
                          </span>
                        </span>
                        <span className="flex flex-col items-end gap-1">
                          <span className="tabular font-semibold">
                            {units(r.amount, meta)} {meta.symbol}
                          </span>
                          {p && <Pill tone={p.tone}>{p.label}</Pill>}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {visible.length > shown && (
                <div className="border-t border-line p-2 text-center">
                  <button
                    type="button"
                    onClick={() => setShown((s) => s + PAGE)}
                    className="rounded-lg px-4 py-2 text-[15px] font-semibold text-brand hover:bg-brand-soft"
                  >
                    Show more
                  </button>
                </div>
              )}
            </Card>
          </div>

          <Disclosure title="How we counted">
            <div className="space-y-4 px-5 py-4">
              <p className="text-muted">
                Each past payout is sorted by amount under your two limits. “Blocked” means the same
                person was already paid for the same link (share-tracking parts of links ignored).
                Payee lists aren’t applied, because the DAO never had one. With Earmark, a lead the
                DAO trusts reviews the work before paying.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-muted">
                      <th className="py-2 pr-4 font-medium">Would be</th>
                      {OUTCOMES.map((o) => (
                        <th key={o.key} className="py-2 pl-4 text-right font-medium">
                          Council: {o.label.toLowerCase()}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {PATHS.map((p) => (
                      <tr key={p.key}>
                        <td className="py-2.5 pr-4">
                          <Pill tone={p.tone}>{p.label}</Pill>
                        </td>
                        {OUTCOMES.map((o) => (
                          <td key={o.key} className="tabular py-2.5 pl-4 text-right">
                            {n(result.table[p.key][o.key])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </Disclosure>
        </div>
      )}
    </div>
  );
}

function LimitInput({
  label,
  value,
  onChange,
  unit,
  presets,
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  unit: string;
  presets: string[];
  className: string;
}) {
  return (
    <div className="space-y-2">
      <label className="block space-y-1.5">
        <span className="font-medium">{label}</span>
        <span className="flex items-center rounded-xl border border-slate-300 bg-white focus-within:border-brand focus-within:ring-4 focus-within:ring-brand/20">
          <input
            className={className}
            inputMode="decimal"
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
          <span className="pr-3.5 font-medium text-muted">{unit}</span>
        </span>
      </label>
      {presets.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted">
          <span>Typical payout:</span>
          {presets.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onChange(p)}
              className={`tabular rounded-full px-2.5 py-0.5 ring-1 ring-inset ${
                value === p ? "bg-brand-soft text-brand ring-brand/30" : "ring-line hover:text-ink"
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** What the council really did with the proposal, in plain words. */
function councilDid(status: string): string {
  switch (status) {
    case "Approved":
      return "council paid it";
    case "Rejected":
      return "council rejected it";
    case "InProgress":
      return "vote still open";
    case "Expired":
      return "expired without a vote";
    case "Removed":
      return "removed by the council";
    case "Failed":
      return "approved, but the payment failed";
    default:
      return status.toLowerCase();
  }
}
