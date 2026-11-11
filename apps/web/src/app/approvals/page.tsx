import { Inbox, type InboxBudget } from "@/components/inbox";
import { describeChange } from "@/lib/activity";
import { CONTRACT } from "@/lib/config";
import { loadBase, loadDecisions, loadPauses, loadRequests } from "@/lib/data";
import { money } from "@/lib/format";
import { listIntentsPayees } from "@/lib/intents";
import { contractTopUp, getRequest, isEligible, listQueued } from "@/lib/near";
import { nearAmount } from "@/lib/token";

export const dynamic = "force-dynamic";

/** Decided payments shown under "Recently decided", per budget. */
const RECENT = 3;

export default async function ApprovalsPage() {
  const { config, budgets, meta } = await loadBase();
  const requests = await loadRequests(budgets, 50);
  // A waiting payment older than the newest 50 is still shown.
  const missing = budgets.flatMap((b) => b.pending_requests.filter((id) => !requests.has(id)));
  for (const [id, r] of await Promise.all(
    missing.map(async (id) => [id, await getRequest(id)] as const),
  )) {
    if (r) requests.set(id, r);
  }
  const open = budgets.filter((b) => !b.closed);
  const pausedKeys = new Set(
    open.flatMap((b) => [
      ...(b.paused ? [`${b.id}|`] : []),
      ...b.spenders.filter(([, l]) => l.paused).map(([a]) => `${b.id}|${a}`),
    ]),
  );
  const [queued, pauses, decisions, topUp, nearCom] = await Promise.all([
    listQueued(),
    loadPauses(pausedKeys),
    loadDecisions(),
    contractTopUp().catch(() => null),
    Promise.all(open.map(async (b) => [b.id, await listIntentsPayees(b.id)] as const)).then(
      (rows) => new Map(rows),
    ),
  ]);
  const spenders = [...new Set(open.flatMap((b) => b.spenders.map(([a]) => a)))];
  const eligible = new Map(
    await Promise.all(spenders.map(async (s) => [s, await isEligible(s)] as const)),
  );

  const data: InboxBudget[] = open.flatMap((b) => {
    const m = meta.get(b.id);
    if (!m) return [];
    const pause = (spender: string) => {
      const p = pauses.get(`${b.id}|${spender}`);
      return p ? { pausedBy: p.by, pausedNs: p.ns } : {};
    };
    return [
      {
        id: b.id,
        name: b.name,
        approvers: b.approvers,
        paused: b.paused,
        ...(b.paused ? pause("") : {}),
        symbol: m.symbol,
        decimals: m.decimals,
        ceiling: money(b.raise_ceiling, m),
        pending: b.pending_requests.flatMap((rid) => {
          const r = requests.get(rid);
          return r
            ? [
                {
                  id: rid,
                  spender: r.spender,
                  payee: r.payee,
                  amount: money(r.amount, m),
                  work: r.work_ref,
                  memo: r.memo,
                  createdNs: r.created_at_ns,
                  expiresNs: (
                    BigInt(r.created_at_ns) +
                    BigInt(b.pending_ttl_secs) * 1_000_000_000n
                  ).toString(),
                },
              ]
            : [];
        }),
        recent: [...requests.entries()]
          .filter(([, r]) => r.envelope_id === b.id && r.decided_by !== null)
          .map(([rid, r]) => ({ rid, r, at: BigInt(decisions.get(rid) ?? r.created_at_ns) }))
          // Newest decision first; without its event, the ask time is the best guess.
          .sort((x, y) => (y.at > x.at ? 1 : y.at < x.at ? -1 : 0))
          .slice(0, RECENT)
          .map(({ rid, r }) => ({
            id: rid,
            amount: money(r.amount, m),
            payee: r.payee,
            status: r.status,
            by: r.decided_by ?? "",
            decidedNs: decisions.get(rid) ?? null,
          })),
        changes: queued
          .filter(([, c]) => c.envelope_id === b.id)
          .map(([cid, c]) => {
            const [kind = "", v] = Object.entries(c.change)[0] ?? [];
            return {
              id: cid,
              kind,
              spender: typeof v?.spender === "string" ? v.spender : null,
              payee: typeof v?.payee === "string" ? v.payee : null,
              text: describeChange(c.change, m),
              by: c.queued_by,
              effectiveNs: c.effective_at_ns,
            };
          }),
        payees: b.payees,
        nearComPayees: nearCom.get(b.id) ?? [],
        spenders: b.spenders.map(([a, l]) => ({
          id: a,
          paused: l.paused,
          ...(l.paused ? pause(a) : {}),
          limit: money(l.auto_limit, m),
          eligible: eligible.get(a) ?? false,
        })),
      },
    ];
  });

  return (
    <div className="space-y-8">
      <h1 className="text-3xl font-bold tracking-tight">Approvals</h1>
      {topUp && topUp.needed > 0n && (
        <p className="rounded-xl bg-amber-50 px-4 py-3 text-amber-900">
          New payments are paused: the contract is low on NEAR for storage. Send{" "}
          <span className="font-semibold">{nearAmount(topUp.needed.toString())}</span> to{" "}
          <span className="font-mono text-sm">{CONTRACT}</span> from any account.
        </p>
      )}
      <Inbox budgets={data} delaySecs={Number(config.loosen_delay_secs)} />
    </div>
  );
}
