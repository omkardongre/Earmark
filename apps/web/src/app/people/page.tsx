import Link from "next/link";
import { Avatar, Card, Empty, Pill, Section } from "@/components/ui";
import { loadBase } from "@/lib/data";
import { ago, duration, money } from "@/lib/format";
import { getPayeeRecord, getRecord, isEligible } from "@/lib/near";

export const dynamic = "force-dynamic";

/**
 * Everyone in a budget, with the record the contract keeps: leads (what they paid out, whether
 * an approver may raise their limit) and contributors (what they were paid). Every number comes
 * from a contract view; only confirmed payments count.
 */
export default async function PeoplePage() {
  const base = await loadBase();
  const { budgets, meta, config } = base;
  const m = meta.values().next().value;
  const unique = (xs: string[]) => [...new Set(xs)];
  const leads = unique(budgets.flatMap((b) => b.spenders.map(([a]) => a)));
  const payees = unique(budgets.flatMap((b) => b.payees));
  const council = unique(budgets.flatMap((b) => b.approvers));

  const [leadRows, payeeRows] = await Promise.all([
    Promise.all(
      leads.map(async (a) => {
        const [record, eligible] = await Promise.all([getRecord(a), isEligible(a)]);
        const limits = budgets.flatMap((b) => b.spenders).find(([s]) => s === a)?.[1];
        return { a, record, eligible, limits };
      }),
    ),
    Promise.all(payees.map(async (a) => ({ a, record: await getPayeeRecord(a) }))),
  ]);
  payeeRows.sort((x, y) => Number(BigInt(y.record.paid_total) - BigInt(x.record.paid_total)));
  const amount = (v: string) => (m ? money(v, m) : v);
  const rules = config.eligibility;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight">People</h1>
        <p className="text-muted">
          Each record is kept by the contract and counts confirmed payments only.
        </p>
      </div>

      <Section title="Contributors">
        {payeeRows.length === 0 ? (
          <Empty>No contributors yet.</Empty>
        ) : (
          <Card className="divide-y divide-line">
            {payeeRows.map(({ a, record }) => (
              <Row key={a} account={a}>
                <span className="tabular font-semibold">{amount(record.paid_total)}</span>
                <span className="text-sm text-muted">
                  {record.paid_count} payment{record.paid_count === 1 ? "" : "s"}
                  {record.last_paid_at_ns && <> · last {ago(record.last_paid_at_ns)}</>}
                </span>
              </Row>
            ))}
          </Card>
        )}
      </Section>

      <Section title="Leads">
        {leadRows.length === 0 ? (
          <Empty>No leads yet.</Empty>
        ) : (
          <Card className="divide-y divide-line">
            {leadRows.map(({ a, record, eligible, limits }) => (
              <Row key={a} account={a}>
                <span className="flex flex-wrap items-center justify-end gap-2">
                  {limits?.paused && <Pill tone="amber">Paused</Pill>}
                  {eligible ? <Pill tone="green">Eligible for a raise</Pill> : <Pill>Not yet</Pill>}
                </span>
                <span className="text-sm text-muted">
                  paid {amount(record.paid_total)} in {record.paid_count} · limit{" "}
                  {limits ? amount(limits.auto_limit) : "–"}
                  {record.rejected_for_cause > 0 && (
                    <> · {record.rejected_for_cause} rejected for cause</>
                  )}
                </span>
              </Row>
            ))}
          </Card>
        )}
        <p className="mt-3 text-sm text-muted">
          A raise needs {rules.min_paid_count} paid payments over{" "}
          {duration(Number(rules.min_history_secs))} and no rejection for cause in{" "}
          {duration(Number(rules.cause_cooldown_secs))}. An approver still decides, and the raise
          waits {duration(Number(config.loosen_delay_secs))} before it applies.
        </p>
      </Section>

      <Section title="Council">
        <Card className="divide-y divide-line">
          {council.map((a) => (
            <Row key={a} account={a}>
              <span className="text-sm text-muted">approves payments above a lead’s limit</span>
            </Row>
          ))}
        </Card>
      </Section>
    </div>
  );
}

function Row({ account, children }: { account: string; children: React.ReactNode }) {
  return (
    <Link
      href={`/people/${account}`}
      className="flex items-center justify-between gap-3 px-5 py-3.5 hover:bg-slate-50"
    >
      <span className="flex shrink-0 items-center gap-3">
        <Avatar id={account} />
        <span className="font-medium">{account.split(".")[0]}</span>
      </span>
      <span className="flex min-w-0 flex-col items-end gap-0.5 text-right">{children}</span>
    </Link>
  );
}
