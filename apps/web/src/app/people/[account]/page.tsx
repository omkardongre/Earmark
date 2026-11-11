import Link from "next/link";
import { notFound } from "next/navigation";
import { ActivityList } from "@/components/activity-list";
import { Avatar, Card, Disclosure, ExternalLink, Pill, Section } from "@/components/ui";
import { accountUrl } from "@/lib/config";
import { loadActivity, loadBase } from "@/lib/data";
import { ago, duration, money, shortName } from "@/lib/format";
import { getPayeeRecord, getRecord, getTrust, isEligible } from "@/lib/near";

export const dynamic = "force-dynamic";

export default async function PersonPage({ params }: { params: Promise<{ account: string }> }) {
  const account = decodeURIComponent((await params).account);
  if (!/^[a-z0-9._-]{2,64}$/.test(account)) notFound();
  const base = await loadBase();
  const [record, eligible, paid, activity] = await Promise.all([
    getRecord(account),
    isEligible(account),
    getPayeeRecord(account),
    loadActivity(base, { account }),
  ]);
  const { config, budgets, meta } = base;
  const name = shortName(account);

  const roles = budgets.flatMap((b) => {
    const r: string[] = [];
    if (b.spenders.some(([a]) => a === account)) r.push("Spender");
    if (b.approvers.includes(account)) r.push("Approver");
    if (b.payees.includes(account)) r.push("Payee");
    return r.length ? [{ b, r }] : [];
  });
  // Task record per budget where they can be paid (null on a contract without tasks).
  const trust = new Map(
    await Promise.all(
      roles
        .filter((x) => x.r.includes("Payee"))
        .map(async ({ b }) => [b.id, await getTrust(b.id, account).catch(() => null)] as const),
    ),
  );
  const isSpender = record.paid_count > 0 || roles.some((x) => x.r.includes("Spender"));
  const firstMeta = meta.values().next().value;
  const rules = config.eligibility;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div className="flex items-center gap-4">
        <Avatar id={account} size="lg" />
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{name}</h1>
          <p className="text-muted">
            {roles
              .flatMap((x) => x.r)
              .filter((v, i, a) => a.indexOf(v) === i)
              .join(" · ") || "Not part of a budget"}
          </p>
        </div>
      </div>

      {isSpender && (
        <Card className="space-y-5 p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">Record</h2>
            {eligible ? (
              <Pill tone="green">Eligible for a raise</Pill>
            ) : (
              <Pill>Not eligible for a raise yet</Pill>
            )}
          </div>
          <div className="grid grid-cols-3 gap-4">
            <Num label="Payments" value={String(record.paid_count)} />
            <Num
              label="Total paid"
              value={firstMeta ? money(record.paid_total, firstMeta) : record.paid_total}
            />
            <Num label="Rejected for cause" value={String(record.rejected_for_cause)} />
          </div>
        </Card>
      )}

      {paid.paid_count > 0 && (
        <Card className="space-y-5 p-6">
          <h2 className="font-semibold">Paid for work</h2>
          <div className="grid grid-cols-3 gap-4">
            <Num label="Payments" value={String(paid.paid_count)} />
            <Num
              label="Total received"
              value={firstMeta ? money(paid.paid_total, firstMeta) : paid.paid_total}
            />
            <Num label="Last paid" value={paid.last_paid_at_ns ? ago(paid.last_paid_at_ns) : "–"} />
          </div>
        </Card>
      )}
      <Section title="Budgets">
        {roles.length === 0 ? (
          <p className="text-muted">Not part of any budget.</p>
        ) : (
          <Card className="divide-y divide-line">
            {roles.map(({ b, r }) => {
              const m = meta.get(b.id);
              const limits = b.spenders.find(([a]) => a === account)?.[1];
              return (
                <Link
                  key={b.id}
                  href={`/budgets/${b.id}`}
                  className="flex items-center justify-between gap-3 px-5 py-3.5 hover:bg-slate-50"
                >
                  <span className="font-medium">{b.name}</span>
                  <span className="flex flex-wrap items-center justify-end gap-2 text-sm text-muted">
                    {limits && m && <span>pays at once up to {money(limits.auto_limit, m)}</span>}
                    {(() => {
                      const t = trust.get(b.id);
                      if (!t || !m) return null;
                      if (t.trusted)
                        return <Pill tone="green">Trusted up to {money(t.trusted_limit, m)}</Pill>;
                      return t.record.tasks_paid > 0 ? (
                        <span>
                          {t.record.tasks_paid} {t.record.tasks_paid === 1 ? "task" : "tasks"} done
                        </span>
                      ) : null;
                    })()}
                    {r.map((x) => (
                      <Pill key={x} tone="brand">
                        {x}
                      </Pill>
                    ))}
                  </span>
                </Link>
              );
            })}
          </Card>
        )}
      </Section>

      <Section title="Activity">
        <ActivityList first={activity} account={account} />
      </Section>

      <Disclosure title="Details">
        <div className="space-y-2 px-5 py-4 text-muted">
          {isSpender && (
            <p>
              A raise needs {rules.min_paid_count} paid payments over{" "}
              {duration(Number(rules.min_history_secs))} and no rejection for cause in{" "}
              {duration(Number(rules.cause_cooldown_secs))}. An approver still decides; limits never
              rise on their own.
              {record.first_paid_at_ns && <> First payment {ago(record.first_paid_at_ns)}.</>}
            </p>
          )}
          <p>
            Account: <ExternalLink href={accountUrl(account)}>{account}</ExternalLink>
          </p>
        </div>
      </Disclosure>
    </div>
  );
}

function Num({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="tabular text-2xl font-bold tracking-tight">{value}</p>
      <p className="text-sm text-muted">{label}</p>
    </div>
  );
}
