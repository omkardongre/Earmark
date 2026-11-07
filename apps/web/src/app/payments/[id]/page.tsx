import Link from "next/link";
import { notFound } from "next/navigation";
import { LocalTime } from "@/components/local-time";
import { PaymentSteps } from "@/components/payment-steps";
import { SettleButton } from "@/components/settle-button";
import { Card, ExternalLink, Person, Pill } from "@/components/ui";
import { proposalUrl, txUrl } from "@/lib/config";
import { loadBase, requestEvents } from "@/lib/data";
import { duration, money, STATUS, shortName } from "@/lib/format";
import { getRequest } from "@/lib/near";
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
      return `DAO vote: above ${oneLimit}, the most one approver can sign`;
  }
}

/** One payment, like a receipt: what, to whom, when, why, who decided, and each step. */
export default async function PaymentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tx?: string | string[] }>;
}) {
  const id = decodeURIComponent((await params).id);
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(id)) notFound();
  const [r, base, events, query] = await Promise.all([
    getRequest(id),
    loadBase(),
    requestEvents(id),
    searchParams,
  ]);
  if (!r) notFound();
  const b = base.budgets.find((x) => x.id === r.envelope_id);
  const m = base.meta.get(r.envelope_id);
  if (!b || !m) notFound();
  const s = STATUS[r.status];
  const link = /^https?:\/\//.test(r.work_ref) ? r.work_ref : null;
  const approved = events?.some((e) => e.event === "spend_approved");
  // The first transaction: from the history, or (right after sending, before the history has
  // it) from the link the pay form opened. Only a base58 hash is accepted from the URL.
  const fromUrl = typeof query.tx === "string" && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(query.tx);
  const tx = events?.[0]?.tx ?? (fromUrl ? (query.tx as string) : null);
  const expiresNs = (
    BigInt(r.created_at_ns) +
    BigInt(b.pending_ttl_secs) * 1_000_000_000n
  ).toString();
  const next = nextStep(r, expiresNs, Number(b.pending_ttl_secs));

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Link href={`/budgets/${b.id}`} className="text-muted hover:text-ink">
        ← {b.name}
      </Link>

      <Card className="space-y-6 p-6">
        <div className="space-y-2">
          <Pill tone={s.tone}>{s.label}</Pill>
          <p className="tabular text-4xl font-bold tracking-tight">{money(r.amount, m)}</p>
          <p className="flex flex-wrap items-center gap-2 text-muted">
            to <Person id={r.payee} /> · asked by <Person id={r.spender} />
          </p>
          {next && <p className="rounded-xl bg-amber-50 px-4 py-3 text-amber-900">{next}</p>}
          {r.status === "escalated" && r.dao_proposal_id !== null && (
            <SettleButton requestId={id} />
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
              <dd>{r.failure.replaceAll("_", " ")}</dd>
            </>
          )}
          {tx && (
            <>
              <dt className="text-muted">Transaction</dt>
              <dd>
                <ExternalLink href={txUrl(tx)}>View on explorer</ExternalLink>
              </dd>
            </>
          )}
        </dl>
      </Card>

      <Card className="p-6">
        <h2 className="mb-4 font-semibold">Steps</h2>
        <PaymentSteps id={id} payee={r.payee} first={events} />
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
      return "Waiting for the DAO vote. It pays out if the proposal passes. After the vote, anyone can record the result.";
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
