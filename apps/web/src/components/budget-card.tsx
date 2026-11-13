import Link from "next/link";
import { money, units } from "@/lib/format";
import type { PayPrefill } from "@/lib/request-link";
import type { Budget, TokenMeta } from "@/lib/types";
import { AnimatedNumber } from "./animated-number";
import { ApproveBadge } from "./approve-badge";
import { PaySheet } from "./pay-sheet";
import { AskButton } from "./request-form";
import { CardTasks, Earned, type OpenTask } from "./role-views";
import { ForRoles } from "./roles";
import { ButtonLink, Card, Pill } from "./ui";

/** The one thing a lead checks first: what's left, and a button to pay. */
export function BudgetCard({
  b,
  m,
  link = true,
  period,
  prefill = null,
  earned = {},
  openTasks = null,
}: {
  b: Budget;
  m: TokenMeta;
  link?: boolean;
  /** "30 days": also shows what was used this period, for the budget page. */
  period?: string;
  /** From an "Ask to be paid" link (budget page only). */
  prefill?: PayPrefill | null;
  /** Paid per payee from this budget, for a contributor's "You earned" line. */
  earned?: Record<string, string>;
  /** Open tasks, for the card's way into the task board (home); null hides it. */
  openTasks?: OpenTask[] | null;
}) {
  const team = { spenders: b.spenders.map(([a]) => a), approvers: b.approvers, payees: b.payees };
  // The bar is what's left of everything the budget ever got: held now plus already paid out.
  // (`balance` alone equals `available` when nothing waits, which drew a full bar.)
  const funded = BigInt(b.balance) + BigInt(b.spent_total);
  const leftPct = funded > 0n ? Number((BigInt(b.available) * 100n) / funded) : 0;
  // Waiting for approval, being paid, or reserved for open tasks.
  const waiting = BigInt(b.committed) + BigInt(b.in_flight);
  return (
    <Card className="space-y-5 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {link ? (
          <Link href={`/budgets/${b.id}`} className="text-lg font-semibold hover:underline">
            {b.name}
          </Link>
        ) : (
          <span className="text-lg font-semibold">Budget left</span>
        )}
        <div className="flex gap-1.5">
          {b.closed && <Pill>Closed</Pill>}
          {b.paused && <Pill tone="amber">Paused</Pill>}
          <ApproveBadge approvers={b.approvers} count={b.pending_requests.length} />
        </div>
      </div>
      <div className="space-y-3">
        {/* The budget's money, the same for everyone: not the signed-in person's balance. */}
        <div>
          {link && <p className="text-sm font-medium text-muted">Budget left</p>}
          <p className="tabular text-4xl font-bold tracking-tight">
            <AnimatedNumber value={b.available} meta={m} />{" "}
            <span className="text-lg font-semibold text-muted">{m.symbol}</span>
          </p>
        </div>
        <div
          className="h-2 overflow-hidden rounded-full bg-slate-100"
          role="img"
          aria-label={`${units(b.available, m)} of ${money(funded, m)} left`}
        >
          <div
            className="h-full rounded-full bg-brand motion-safe:transition-[width] motion-safe:duration-700"
            style={{ width: `${leftPct}%` }}
          />
        </div>
        {/* Budget page, for the team: this period's use against the cap is what decides the next
            payment, so it replaces the all-time "paid out" line. */}
        {period ? (
          <>
            <ForRoles team={team} roles={["lead", "approver", "visitor"]}>
              <p className="tabular text-muted">
                <AnimatedNumber value={b.period_spent} meta={m} /> of {money(b.period_cap, m)} used
                · resets every {period}
                {waiting > 0n && (
                  <>
                    <br />
                    <AnimatedNumber value={waiting.toString()} meta={m} /> {m.symbol} set aside
                  </>
                )}
              </p>
            </ForRoles>
            <ForRoles team={team} roles={["contributor"]}>
              <p className="tabular text-muted">
                <AnimatedNumber value={b.spent_total} meta={m} /> {m.symbol} paid out
              </p>
            </ForRoles>
          </>
        ) : (
          <p className="tabular text-muted">
            {waiting > 0n && (
              <>
                <AnimatedNumber value={waiting.toString()} meta={m} /> {m.symbol} set aside ·{" "}
              </>
            )}
            <AnimatedNumber value={b.spent_total} meta={m} /> {m.symbol} paid out
          </p>
        )}
      </div>
      <Earned team={team} earned={earned} meta={m} />
      {link && openTasks && <CardTasks budgetId={b.id} team={team} open={openTasks} />}
      {!b.closed && (
        <div className="flex flex-wrap gap-2">
          <PaySheet
            budgetId={b.id}
            token={b.token_id}
            payees={b.payees}
            spenders={team.spenders}
            meta={m}
            prefill={prefill}
          />
          <AskButton budgetId={b.id} payees={b.payees} spenders={team.spenders} />
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
