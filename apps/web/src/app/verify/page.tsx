import type { Metadata } from "next";
import Link from "next/link";
import { LocalTime } from "@/components/local-time";
import { Card, ExternalLink, Pill } from "@/components/ui";
import { StaleNotice } from "@/components/verify-stale-notice";
import { getVerifyReport } from "@/lib/verify";

// Checks run on the server at request time; getVerifyReport reuses one run for 30 s.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Check it yourself · Earmark" };

/** Live, keyless checks of the deployed contract: the browser version of `make verify`. */
export default async function VerifyPage() {
  const report = await getVerifyReport();
  const failed = report.checks.filter((c) => !c.ok && !c.unknown).length;
  const unchecked = report.checks.filter((c) => c.unknown).length;
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-bold tracking-tight">Check it yourself</h1>
          {failed === 0 && unchecked === 0 ? (
            <Pill tone="green">All {report.checks.length} checks pass</Pill>
          ) : failed === 0 ? (
            <Pill>
              {report.checks.length - unchecked} of {report.checks.length} pass · {unchecked} not
              checked yet
            </Pill>
          ) : (
            <Pill tone="red">
              {failed} of {report.checks.length} failed
            </Pill>
          )}
        </div>
        <p className="text-lg text-muted">
          Don’t trust us, read the chain. Each check below is a public read of{" "}
          <span className="font-medium text-ink">{report.contract}</span>, with no keys.
        </p>
      </div>
      <StaleNotice since={report.staleFrom} />
      <Card className="divide-y divide-line">
        {report.checks.map((c) => (
          <div key={c.id} className="flex gap-4 px-5 py-4">
            <span
              className={`mt-0.5 grid size-7 shrink-0 place-items-center rounded-full text-sm font-bold ${
                c.ok
                  ? "bg-emerald-50 text-emerald-700"
                  : c.unknown
                    ? "bg-slate-100 text-slate-500"
                    : "bg-rose-50 text-rose-700"
              }`}
              role="img"
              aria-label={c.ok ? "Pass" : c.unknown ? "Not checked" : "Fail"}
            >
              {c.ok ? "✓" : c.unknown ? "?" : "✕"}
            </span>
            <div className="min-w-0 space-y-1">
              <p className="font-semibold">{c.title}</p>
              <p className="text-muted">{c.detail}</p>
              <details className="text-sm">
                <summary className="cursor-pointer list-none font-medium text-brand hover:underline [&::-webkit-details-marker]:hidden">
                  Proof
                </summary>
                <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                  {c.evidence.map((e) => (
                    <ExternalLink key={e.href} href={e.href}>
                      {e.label} ↗
                    </ExternalLink>
                  ))}
                </p>
              </details>
            </div>
          </div>
        ))}
      </Card>
      <div className="space-y-1 text-muted">
        <p>
          Run{" "}
          <code className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[0.9em] text-ink">
            make verify
          </code>{" "}
          to check the same from your terminal, no keys needed.
        </p>
        <p className="text-sm">
          Checked <LocalTime ns={String(BigInt(report.checkedAt) * 1_000_000n)} />.{" "}
          <Link href="/verify" className="font-medium text-brand hover:underline" prefetch={false}>
            Check again
          </Link>
        </p>
      </div>
    </div>
  );
}
