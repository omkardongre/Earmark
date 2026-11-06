import Link from "next/link";
import { money, units } from "@/lib/format";
import type { Budget, TokenMeta } from "@/lib/types";
import { ApproveBadge } from "./approve-badge";
import { PaySheet } from "./pay-sheet";
import { ButtonLink, Card, Pill } from "./ui";

/** The one thing a lead checks first: what's left, and a button to pay. */
export function BudgetCard({
  b,
  m,
  link = true,
  period,
}: {
  b: Budget;
  m: TokenMeta;
  link?: boolean;
  /** "30 days": also shows what was used this period, for the budget page. */
  period?: string;
}) {
  // The bar is what's left of everything the budget ever got: held now plus already paid out.
  // (`balance` alone equals `available` when nothing waits, which drew a full bar.)
  const funded = BigInt(b.balance) + BigInt(b.spent_total);
  const leftPct = funded > 0n ? Number((BigInt(b.available) * 100n) / funded) : 0;
  const waiting = BigInt(b.committed) + BigInt(b.in_flight);
  return (
    <Card className="space-y-5 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {link ? (
          <Link href={`/budgets/${b.id}`} className="text-lg font-semibold hover:underline">
            {b.name}
          </Link>
        ) : (
          <span className="text-lg font-semibold">Available</span>
        )}
        <div className="flex gap-1.5">
          {b.closed && <Pill>Closed</Pill>}
          {b.paused && <Pill tone="amber">Paused</Pill>}
          <ApproveBadge approvers={b.approvers} count={b.pending_requests.length} />
        </div>
      </div>
      <div className="space-y-3">
        <p className="tabular text-4xl font-bold tracking-tight">
          {units(b.available, m)}{" "}
          <span className="text-lg font-semibold text-muted">{m.symbol}</span>
          {link && (
            <span className="ml-2 align-middle text-base font-medium text-muted">available</span>
          )}
        </p>
        <div
          className="h-2 overflow-hidden rounded-full bg-slate-100"
          role="img"
          aria-label={`${units(b.available, m)} of ${money(funded, m)} left`}
        >
          <div className="h-full rounded-full bg-brand" style={{ width: `${leftPct}%` }} />
        </div>
        <p className="tabular text-muted">
          {waiting > 0n && <>{money(waiting, m)} waiting for approval · </>}
          {money(b.spent_total, m)} paid out
        </p>
        {period && (
          <p className="tabular text-muted">
            {units(b.period_spent, m)} of {money(b.period_cap, m)} used this period ({period})
          </p>
        )}
      </div>
      {!b.closed && (
        <div className="flex flex-wrap gap-2">
          <PaySheet
            budgetId={b.id}
            payees={b.payees}
            spenders={b.spenders.map(([a]) => a)}
            meta={m}
          />
          {link && (
            <ButtonLink href={`/budgets/${b.id}`} variant="secondary">
              View budget
            </ButtonLink>
          )}
        </div>
      )}
    </Card>
  );
}
