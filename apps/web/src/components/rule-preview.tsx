"use client";

import { useEffect, useMemo, useState } from "react";
import type { PreviewData } from "@/app/api/preview/route";
import { toBase, units } from "@/lib/format";
import { CountUp } from "./animated-number";
import { Button, Card, Disclosure, Pill, Skeleton } from "./ui";

type Path = "auto" | "one" | "dao" | "duplicate";
type Outcome = "approved" | "rejected" | "expired" | "other";

const PATHS: {
  key: Path;
  label: string;
  tone: "green" | "amber" | "blue" | "red";
  hint: string;
  bar: string;
}[] = [
  {
    key: "auto",
    label: "Paid at once",
    tone: "green",
    hint: "within the limit",
    bar: "bg-emerald-400",
  },
  {
    key: "one",
    label: "One approval",
    tone: "amber",
    hint: "one approver signs",
    bar: "bg-amber-400",
  },
  { key: "dao", label: "DAO vote", tone: "blue", hint: "the council votes", bar: "bg-sky-400" },
  {
    key: "duplicate",
    label: "Blocked",
    tone: "red",
    hint: "work already paid",
    bar: "bg-rose-400",
  },
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

const PAGE = 5;
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

  // Tokens the DAO actually paid out in.
  const usedTokens = useMemo(
    () =>
      data
        ? data.tokens
            .map((t, i) => ({ ...t, i, count: data.transfers.filter((x) => x[1] === i).length }))
            .filter((t) => t.count > 0)
        : [],
    [data],
  );

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

  const input =
    "h-12 w-full min-w-0 bg-transparent px-4 text-lg font-semibold outline-none tabular";
  const visible = result ? result.rows.filter((r) => filter === "all" || r.path === filter) : [];
  const saved =
    result && result.total > 0 ? ((result.total - result.count.dao) / result.total) * 100 : 0;

  return (
    <div className="space-y-5">
      {/* Which DAO: NEARWEEK by default, another one on request. */}
      {editing || (!data && !loading) ? (
        <form
          className="flex flex-col gap-2 rounded-2xl border border-line bg-white p-3 shadow-card sm:flex-row"
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
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-line bg-white px-4 py-3 shadow-card">
          <span
            aria-hidden
            className="grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-500 text-lg font-semibold text-white"
          >
            {daoName(data.dao).charAt(0)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold">{daoName(data.dao)}</span>
            <span className="block text-sm text-muted">
              <span className="tabular font-medium text-ink">{n(data.total)} proposals</span> · read
              from NEAR {since(data.fetchedAt)}
            </span>
          </span>
          <button
            type="button"
            className="rounded-lg px-3 py-2 text-sm font-semibold text-brand hover:bg-brand-soft"
            onClick={() => setEditing(true)}
          >
            Use another DAO
          </button>
        </div>
      ) : null}

      {error && <p className="rounded-xl bg-rose-50 px-4 py-3 text-rose-700">{error}</p>}

      {loading && !data && (
        <div className="space-y-4" aria-busy="true">
          <p className="text-muted">
            Reading every past proposal of the DAO. Big DAOs take up to a minute the first time.
          </p>
          <Skeleton className="h-56 w-full rounded-3xl!" />
        </div>
      )}

      {data && meta && (
        <Card className="grid gap-x-5 gap-y-3 rounded-3xl! p-5 sm:grid-cols-2">
          <LimitInput
            label="Paid at once up to"
            dot="bg-emerald-500"
            value={auto}
            onChange={setAuto}
            unit={meta.symbol}
            className={input}
          />
          <LimitInput
            label="One approval up to"
            dot="bg-amber-400"
            value={one}
            onChange={setOne}
            unit={meta.symbol}
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
          <p className="text-sm text-muted sm:col-span-2">
            Anything above {one || "the second limit"} {meta.symbol} goes to a council vote.
          </p>
          {!rulesOk && (
            <p className="text-rose-700 sm:col-span-2">
              Use amounts, with the first limit no higher than the second.
            </p>
          )}
        </Card>
      )}

      {data && meta && result && (
        <div className="space-y-8">
          <section className="relative overflow-hidden rounded-3xl bg-ink p-6 text-white shadow-card sm:p-8">
            <div
              aria-hidden
              className="absolute -right-24 -top-28 size-80 rounded-full bg-indigo-500/30 blur-3xl"
            />
            <div className="relative flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-indigo-200">Your council would vote on</p>
                <p className="mt-2 flex flex-wrap items-baseline gap-x-3 font-semibold tracking-[-0.03em]">
                  <span className="text-gradient-light text-6xl sm:text-7xl">
                    <CountUp value={result.count.dao} />
                  </span>
                  <span className="text-xl text-white/70">
                    of <span className="tabular">{n(result.total)}</span> payouts
                  </span>
                </p>
              </div>
              {result.total > 0 && (
                <span className="tabular rounded-full bg-emerald-400/15 px-3.5 py-1.5 text-sm font-semibold text-emerald-300 ring-1 ring-emerald-300/25">
                  {saved >= 99.95 ? "100" : saved.toFixed(1)}% fewer votes
                </span>
              )}
            </div>

            {/* One bar, split by path: nearly all of it green is the point. */}
            <div className="relative mt-7 flex h-3 gap-0.5 overflow-hidden rounded-full bg-white/10">
              {PATHS.map((p) =>
                result.count[p.key] > 0 ? (
                  <span
                    key={p.key}
                    className={`${p.bar} h-full transition-[flex-grow] duration-500`}
                    style={{ flexGrow: Math.max(result.count[p.key], result.total * 0.006) }}
                  />
                ) : null,
              )}
            </div>

            <dl className="relative mt-6 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
              {PATHS.map((p) => (
                <div key={p.key}>
                  <dt className="flex items-center gap-2 text-sm text-white/70">
                    <span className={`size-2 rounded-full ${p.bar}`} aria-hidden />
                    {p.label}
                  </dt>
                  <dd className="mt-1 text-3xl font-semibold tracking-tight">
                    <CountUp value={result.count[p.key]} />
                  </dd>
                  <dd className="text-sm text-white/50">{p.hint}</dd>
                </div>
              ))}
            </dl>
          </section>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-xl font-semibold tracking-tight">Every payout</h2>
              <fieldset className="flex flex-wrap gap-1 rounded-full bg-slate-100 p-1">
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
                    className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
                      filter === f.key ? "bg-white text-ink shadow-sm" : "text-muted hover:text-ink"
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </fieldset>
            </div>
            <Card className="overflow-hidden rounded-3xl!">
              {visible.length === 0 ? (
                <p className="px-5 py-8 text-center text-muted">None.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {visible.slice(0, shown).map((r) => {
                    const p = PATHS.find((x) => x.key === r.path);
                    return (
                      <li
                        key={r.id}
                        className="flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-slate-50/70"
                      >
                        <span
                          aria-hidden
                          className="grid size-9 shrink-0 place-items-center rounded-full bg-slate-100 text-sm font-semibold uppercase text-slate-600"
                        >
                          {r.receiver.charAt(0)}
                        </span>
                        <span className="min-w-0 flex-1">
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
                In the Blocked row, “Council: approved” counts work the DAO paid a second time.
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
  dot,
  value,
  onChange,
  unit,
  className,
}: {
  label: string;
  /** The path's colour, matching the result bar. */
  dot: string;
  value: string;
  onChange: (v: string) => void;
  unit: string;
  className: string;
}) {
  return (
    <div>
      <label className="block space-y-1.5">
        <span className="flex items-center gap-2 font-medium">
          <span className={`size-2 rounded-full ${dot}`} aria-hidden />
          {label}
        </span>
        <span className="flex items-center rounded-2xl border border-slate-300 bg-white focus-within:border-brand focus-within:ring-4 focus-within:ring-brand/20">
          <input
            className={className}
            inputMode="decimal"
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
          <span className="pr-3.5 font-medium text-muted">{unit}</span>
        </span>
      </label>
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
