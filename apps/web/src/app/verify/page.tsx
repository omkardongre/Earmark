import type { Metadata } from "next";
import Link from "next/link";
import { LocalTime } from "@/components/local-time";
import { StaleNotice } from "@/components/verify-stale-notice";
import { SOURCE_REPO } from "@/lib/config";
import { display } from "@/lib/fonts";
import { type CheckRow, getVerifyReport } from "@/lib/verify";
// Checks run on the server at request time; getVerifyReport reuses one run for 30 s.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Check it yourself · Earmark" };
/** The checks in three plain questions a council asks, in reading order. */
const GROUPS: { title: string; ids: CheckRow["id"][] }[] = [
  { title: "Who controls the money", ids: ["keys", "upgrades", "owner", "dao", "votes"] },
  { title: "Is it the real code", ids: ["code"] },
  { title: "Do the books add up", ids: ["balances", "reserve"] },
];
type State = "pass" | "warn" | "unknown" | "fail";
const state = (c: CheckRow): State =>
  c.ok ? "pass" : c.warn ? "warn" : c.unknown ? "unknown" : "fail";
const LABEL: Record<State, string> = {
  pass: "Pass",
  warn: "Good to know",
  unknown: "Not checked",
  fail: "Fail",
};
/** Live, keyless checks of the deployed contract: the browser version of `make verify`. */
export default async function VerifyPage() {
  const report = await getVerifyReport();
  const count = (s: State) => report.checks.filter((c) => state(c) === s).length;
  const [passed, notes, unchecked, failed] = [
    count("pass"),
    count("warn"),
    count("unknown"),
    count("fail"),
  ];
  const byId = new Map(report.checks.map((c) => [c.id, c]));
  const grouped = new Set(GROUPS.flatMap((g) => g.ids));
  // A check added later still shows, at the end.
  const groups = [
    ...GROUPS.map((g) => ({
      title: g.title,
      rows: g.ids.flatMap((id) => byId.get(id) ?? []),
    })),
    { title: "More", rows: report.checks.filter((c) => !grouped.has(c.id)) },
  ].filter((g) => g.rows.length > 0);
  const ns = String(BigInt(report.checkedAt) * 1_000_000n);
  return (
    <div className={`${display.className} relative mx-auto max-w-3xl space-y-8`}>
      <div
        aria-hidden
        className="dot-grid pointer-events-none absolute -inset-x-24 -top-16 -z-10 h-[24rem]"
      />
      <div className="rise grid items-end gap-6 sm:grid-cols-[1fr_15rem]">
        <div className="space-y-3">
          <span className="inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-1 text-sm font-medium text-muted ring-1 ring-line backdrop-blur">
            <span className="relative flex size-2">
              <span className="live-ping absolute inline-flex size-full rounded-full bg-emerald-400" />
              <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
            </span>
            Read live from NEAR
          </span>
          <h1 className="text-4xl font-semibold leading-[1.05] tracking-[-0.035em] sm:text-5xl">
            Don’t trust us. <span className="text-gradient">Check it.</span>
          </h1>
          <p className="text-muted">
            Each check is a public read of{" "}
            <span className="font-medium text-ink">{report.contract}</span>. No keys, no sign-in.
          </p>
        </div>
        <Score
          checks={report.checks}
          passed={passed}
          notes={notes}
          unchecked={unchecked}
          failed={failed}
        />
      </div>
      <StaleNotice since={report.staleFrom} />
      {groups.map((g, i) => (
        <section
          key={g.title}
          className="rise space-y-3"
          style={{ animationDelay: `${80 + i * 60}ms` }}
        >
          <h2 className="text-sm font-semibold uppercase tracking-wider text-subtle">{g.title}</h2>
          <ul className="space-y-2.5">
            {g.rows.map((c) => (
              <Check key={c.id} c={c} />
            ))}
          </ul>
        </section>
      ))}
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
        <span>
          Checked <LocalTime ns={ns} />
        </span>
        <span aria-hidden>·</span>
        <Link href="/verify" className="font-medium text-brand hover:underline" prefetch={false}>
          Check again
        </Link>
        <span aria-hidden>·</span>
        <a
          href={`${SOURCE_REPO}#try-it-in-3-minutes`}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-brand hover:underline"
        >
          Run it yourself ↗
        </a>
      </p>
    </div>
  );
}
/** The headline number: how many checks pass, with one bar segment per check. */
function Score({
  checks,
  passed,
  notes,
  unchecked,
  failed,
}: {
  checks: CheckRow[];
  passed: number;
  notes: number;
  unchecked: number;
  failed: number;
}) {
  const seg: Record<State, string> = {
    pass: "bg-emerald-400",
    warn: "bg-amber-400",
    unknown: "bg-white/25",
    fail: "bg-rose-400",
  };
  const sub =
    failed > 0
      ? `${failed} failed`
      : unchecked > 0
        ? `${unchecked} not checked yet`
        : notes > 0
          ? `${notes} good to know`
          : "Everything checks out";
  return (
    <div className="relative overflow-hidden rounded-3xl bg-ink p-5 text-white shadow-card">
      <div
        aria-hidden
        className="absolute -right-16 -top-16 size-44 rounded-full bg-emerald-500/25 blur-3xl"
      />
      <p className="relative text-sm font-medium text-emerald-200">Checks passed</p>
      <p className="tabular relative mt-1 flex items-baseline gap-1.5 font-semibold tracking-[-0.03em]">
        <span className="text-gradient-light text-5xl">{passed}</span>
        <span className="text-xl text-white/40">/ {checks.length}</span>
      </p>
      <div className="relative mt-3 flex gap-1" aria-hidden>
        {checks.map((c) => (
          <span key={c.id} className={`h-1.5 flex-1 rounded-full ${seg[state(c)]}`} />
        ))}
      </div>
      <p className={`relative mt-2.5 text-sm ${failed > 0 ? "text-rose-300" : "text-white/70"}`}>
        {sub}
      </p>
    </div>
  );
}
function Check({ c }: { c: CheckRow }) {
  const s = state(c);
  const ring: Record<State, string> = {
    pass: "ring-line",
    warn: "ring-amber-300 bg-amber-50/60",
    unknown: "ring-line",
    fail: "ring-rose-300 bg-rose-50/60",
  };
  return (
    <li className={`flex gap-4 rounded-2xl bg-white p-4 shadow-card ring-1 sm:p-5 ${ring[s]}`}>
      <StatusIcon s={s} />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="font-semibold">{c.title}</p>
          {s !== "pass" && (
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                s === "warn"
                  ? "bg-amber-100 text-amber-800"
                  : s === "fail"
                    ? "bg-rose-100 text-rose-700"
                    : "bg-slate-100 text-slate-600"
              }`}
            >
              {LABEL[s]}
            </span>
          )}
        </div>
        <p className="text-[15px] text-muted">{c.detail}</p>
        {c.evidence.length > 0 && (
          <p className="flex flex-wrap gap-2 pt-1.5">
            {c.evidence.map((e) => (
              <a
                key={e.href}
                href={e.href}
                target="_blank"
                rel="noreferrer"
                className="rounded-full bg-slate-100 px-2.5 py-1 text-[13px] font-medium text-ink transition-colors hover:bg-brand-soft hover:text-brand"
              >
                {e.label} ↗
              </a>
            ))}
          </p>
        )}
      </div>
    </li>
  );
}
function StatusIcon({ s }: { s: State }) {
  const tone: Record<State, string> = {
    pass: "bg-emerald-500 text-white shadow-[0_4px_12px_-4px_rgb(16_185_129/70%)]",
    warn: "bg-amber-400 text-white shadow-[0_4px_12px_-4px_rgb(245_158_11/70%)]",
    unknown: "bg-slate-200 text-slate-600",
    fail: "bg-rose-500 text-white shadow-[0_4px_12px_-4px_rgb(244_63_94/70%)]",
  };
  return (
    <span
      role="img"
      aria-label={LABEL[s]}
      className={`grid size-8 shrink-0 place-items-center rounded-full ${tone[s]}`}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-4"
        aria-hidden
      >
        {s === "pass" && <path d="M5 12.5l4.5 4.5L19 7.5" />}
        {s === "warn" && <path d="M12 7v6M12 17h.01" />}
        {s === "unknown" && <path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6M12 17h.01" />}
        {s === "fail" && <path d="M7 7l10 10M17 7L7 17" />}
      </svg>
    </span>
  );
}
