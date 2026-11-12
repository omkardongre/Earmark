import Link from "next/link";
import { notFound } from "next/navigation";
import { LocalTime } from "@/components/local-time";
import { PaymentSteps } from "@/components/payment-steps";
import { ReceiptButton } from "@/components/receipt-button";
import { SettleButton } from "@/components/settle-button";
import { TelegramWatch } from "@/components/telegram-link";
import { Card, ExternalLink, Person, Pill } from "@/components/ui";
import { WithdrawLink } from "@/components/withdraw-link";
import { proposalUrl, txUrl } from "@/lib/config";
import { loadBase, requestEvents } from "@/lib/data";
import { duration, money, payoutReason, STATUS, shortName } from "@/lib/format";
import { isIntentsRequest } from "@/lib/intents";
import { getProposal, getRequest } from "@/lib/near";
import { alertsOn } from "@/lib/telegram";
import type { SpendRequest } from "@/lib/types";

export const dynamic = "force-dynamic";

/** How the rules handled it, in words a lead uses. */
function ruleText(r: SpendRequest, oneLimit: string): string {
  const who = shortName(r.spender);
  switch (r.tier) {
    case "auto":
      return `Paid at once: within ${who}’s own limit`;
    case "one_approver":
      return `One approval: above ${who}’s limit, up to ${oneLimit}`;
    case "escalate":
      return `DAO vote: over ${oneLimit} needs the DAO`;
    case "trusted":
      return `Paid at once: ${shortName(r.payee)} is a trusted contributor of this budget`;
  }
}

/** One payment, like a receipt: what, to whom, when, why, who decided, and each step. */
export default async function PaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const id = decodeURIComponent((await params).id);
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(id)) notFound();
  const [r, base, events, toNearCom] = await Promise.all([
    getRequest(id),
    loadBase(),
    requestEvents(id),
    isIntentsRequest(id),
  ]);
  if (!r) notFound();
  const b = base.budgets.find((x) => x.id === r.envelope_id);
  const m = base.meta.get(r.envelope_id);
  if (!b || !m) notFound();
  const s = STATUS[r.status];
  const link = /^https?:\/\//.test(r.work_ref) ? r.work_ref : null;
  const approved = events?.some((e) => e.event === "spend_approved");
  const expiresNs = (
    BigInt(r.created_at_ns) +
    BigInt(b.pending_ttl_secs) * 1_000_000_000n
  ).toString();
  const next = nextStep(r, expiresNs, Number(b.pending_ttl_secs));
  const paid = r.status === "paid" || r.status === "paid_by_dao";
  // "Check the DAO result" only once the vote is over; while it's open there's nothing to check.
  const voteOpen =
    r.status === "escalated" && r.dao_proposal_id !== null
      ? await getProposal(base.config.dao_id, Number(r.dao_proposal_id))
          .then((p) => p.status === "InProgress")
          .catch(() => false)
      : false;
  // The receipt names the payout itself: the transaction that moved the money.
  const payout = events?.findLast((e) => e.event === "spend_paid");

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center justify-between gap-3 print:hidden">
        <Link href={`/budgets/${b.id}`} className="text-muted hover:text-ink">
          ← {b.name}
        </Link>
        {paid && <ReceiptButton />}
      </div>

      <div className="hidden print:block">
        <p className="text-2xl font-bold">Payment receipt</p>
        <p className="text-muted">
          Earmark · {b.name} · {base.config.dao_id}
        </p>
      </div>

      <Card className="space-y-6 p-6">
        <div className="space-y-2">
          <Pill tone={s.tone}>{s.label}</Pill>
          <p className="tabular text-4xl font-bold tracking-tight">{money(r.amount, m)}</p>
          <p className="flex flex-wrap items-center gap-2 text-muted">
            to <Person id={r.payee} />
            {toNearCom && <Pill tone="blue">near.com</Pill>} · asked by <Person id={r.spender} />
          </p>
          {next && <p className="rounded-xl bg-amber-50 px-4 py-3 text-amber-900">{next}</p>}
          {next && alertsOn() && (
            <div className="-ml-3 print:hidden">
              <TelegramWatch requestId={id} />
            </div>
          )}
          {r.status === "escalated" && r.dao_proposal_id !== null && !voteOpen && (
            <SettleButton requestId={id} />
          )}
          {r.status === "dao_funded" && (
            <SettleButton requestId={id} payout={r.failure ? "retry" : "first"} />
          )}
          {paid && toNearCom && (
            // What happens next, in one line (the near.com tag above says where it went); the
            // payee's button sits beside it, so the team view has no empty space.
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-sky-50 px-4 py-3 text-sky-900">
              <p>They withdraw it on near.com with the same wallet, to any chain.</p>
              <WithdrawLink payee={r.payee} />
            </div>
          )}
        </div>

        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 border-t border-line pt-5">
          <dt className="text-muted">Date</dt>
          <dd>
            <LocalTime ns={r.created_at_ns} />
          </dd>
          <dt className="text-muted">To</dt>
          <dd className="break-all">{r.payee}</dd>
          <dt className="text-muted">Work</dt>
          <dd className="min-w-0 break-words">
            {link ? (
              <ExternalLink href={link}>{r.work_ref.replace(/^https?:\/\//, "")}</ExternalLink>
            ) : (
              r.work_ref
            )}
          </dd>
          {r.memo && (
            <>
              <dt className="text-muted">Note</dt>
              <dd>{r.memo}</dd>
            </>
          )}
          <dt className="text-muted">Rule</dt>
          <dd>{ruleText(r, money(b.one_approver_limit, m))}</dd>
          {r.decided_by && (
            <>
              <dt className="text-muted">
                {r.status === "rejected" ? "Rejected by" : approved ? "Approved by" : "Decided by"}
              </dt>
              <dd>
                <Person id={r.decided_by} />
              </dd>
            </>
          )}
          {r.dao_proposal_id !== null && (
            <>
              <dt className="text-muted">DAO vote</dt>
              <dd>
                <ExternalLink href={proposalUrl(base.config.dao_id, r.dao_proposal_id)}>
                  Proposal #{r.dao_proposal_id}
                </ExternalLink>
              </dd>
            </>
          )}
          {r.failure && (
            <>
              <dt className="text-muted">
                {r.status === "rejected"
                  ? "Why rejected"
                  : r.status === "failed"
                    ? "Why it failed"
                    : r.status === "escalation_closed"
                      ? "DAO outcome"
                      : "Reason"}
              </dt>
              <dd>{payoutReason(r.failure)}</dd>
            </>
          )}
          {paid && payout && (
            <>
              <dt className="hidden text-muted print:block">Payout transaction</dt>
              <dd className="hidden break-all text-sm print:block">
                {payout.tx}
                <br />
                {txUrl(payout.tx)}
              </dd>
            </>
          )}
          <dt className="hidden text-muted print:block">Receipt id</dt>
          <dd className="hidden break-all text-sm print:block">{id}</dd>
        </dl>
      </Card>

      <Card className="p-6">
        <h2 className="mb-4 font-semibold">Steps</h2>
        <PaymentSteps
          id={id}
          payee={r.payee}
          first={events}
          paidByDao={r.status === "paid_by_dao"}
        />
      </Card>
    </div>
  );
}

/** For a payment that isn't settled: what happens next, and by when. */
function nextStep(r: SpendRequest, expiresNs: string, ttlSecs: number): string | null {
  switch (r.status) {
    case "pending_approval": {
      const left = Number(BigInt(expiresNs) / 1_000_000n) - Date.now();
      return left > 0
        ? `Waiting for an approver · expires in ${remaining(left)}`
        : `No one decided within ${duration(ttlSecs)}, so it won’t be paid.`;
    }
    case "escalating":
      return "Creating the DAO proposal…";
    case "escalated":
      return "Waiting for the DAO vote. If it passes, the DAO sends the money and Earmark pays it out.";
    case "dao_funded":
      return r.failure
        ? "The DAO approved and sent the money, but paying it out didn’t go through. The money is held here. Try again once the payee can receive this token."
        : "The DAO approved and sent the money. One more step pays it out; anyone can do it.";
    case "paying":
      return "Sending the money…";
    default:
      return null;
  }
}

function remaining(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  if (h >= 24) return `${Math.floor(h / 24)} d ${h % 24} h`;
  if (h >= 1) return `${h} h`;
  return `${Math.max(1, Math.round(ms / 60_000))} min`;
}
