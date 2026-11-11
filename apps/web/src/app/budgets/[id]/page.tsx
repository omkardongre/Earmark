import Link from "next/link";
import { notFound } from "next/navigation";
import { ActivityList } from "@/components/activity-list";
import { BudgetCard } from "@/components/budget-card";
import { PaymentsTable } from "@/components/payments-table";
import { Disclosure, Person, Pill, Section } from "@/components/ui";
import { loadActivity, loadBase } from "@/lib/data";
import { duration, money, shortName } from "@/lib/format";
import { listRequests } from "@/lib/near";
import { readPrefill } from "@/lib/request-link";

export const dynamic = "force-dynamic";

export default async function BudgetPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();
  const base = await loadBase();
  const b = base.budgets.find((x) => x.id === id);
  const m = base.meta.get(id);
  if (!b || !m) notFound();
  const [first, activity] = await Promise.all([
    listRequests(id, { limit: 10 }),
    loadActivity(base, { budget: id, skipPayments: true }),
  ]);
  const period = duration(Number(b.period_secs));
  const prefill = b.closed ? null : readPrefill(await searchParams, b.payees, m);

  return (
    <div className="space-y-10">
      <div>
        <Link href="/" className="text-muted hover:text-ink">
          ← Budgets
        </Link>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">{b.name}</h1>
      </div>

      {prefill && (
        <p className="rounded-2xl bg-brand-soft px-5 py-4">
          <span className="font-semibold">{shortName(prefill.payee)}</span> asks to be paid{" "}
          <span className="tabular font-semibold">
            {prefill.amount} {m.symbol}
          </span>
          . A lead of this budget reviews it in the pay form.
        </p>
      )}

      <div className="grid items-start gap-8 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-4 lg:order-2">
          <BudgetCard b={b} m={m} link={false} period={period} prefill={prefill} />
          <Disclosure title="How payments work">
            <div className="divide-y divide-line">
              <Rule tone="green" title="Paid at once">
                Up to each spender’s own limit, to an approved payee.
              </Rule>
              <Rule tone="amber" title="One approval">
                Up to {money(b.one_approver_limit, m)}. Any approver other than the spender.
              </Rule>
              <Rule tone="blue" title="DAO vote">
                Anything larger becomes a normal DAO proposal.
              </Rule>
              <Rule tone="gray" title="Rule changes">
                Loosening waits {duration(Number(base.config.loosen_delay_secs))} and can be
                cancelled. Tightening and pausing apply at once.
              </Rule>
            </div>
          </Disclosure>
          <Disclosure
            title="People"
            hint={`${b.spenders.length + b.approvers.length + b.payees.length}`}
          >
            <div className="divide-y divide-line">
              <Group title="Spenders">
                {b.spenders.map(([acct, l]) => (
                  <div key={acct} className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-2">
                      <Person id={acct} />
                      {l.paused && <Pill tone="amber">Paused</Pill>}
                    </span>
                    <span className="tabular text-sm text-muted">
                      up to {money(l.auto_limit, m)}
                    </span>
                  </div>
                ))}
              </Group>
              <Group title="Approvers">
                {b.approvers.map((a) => (
                  <Person key={a} id={a} />
                ))}
              </Group>
              <Group title="Can be paid">
                {b.payees.map((p) => (
                  <Person key={p} id={p} />
                ))}
              </Group>
            </div>
          </Disclosure>
        </div>

        <div className="min-w-0 space-y-10 lg:order-1">
          <Section
            title="Payments"
            action={
              Number(b.request_count) > 0 && (
                // A plain link: the route handler sends the file as a download.
                <a
                  href={`/api/export/${id}`}
                  download
                  className="rounded-lg px-3 py-1.5 text-sm font-semibold text-brand hover:bg-brand-soft"
                >
                  Download CSV
                </a>
              )
            }
          >
            <PaymentsTable budgetId={id} first={first} total={Number(b.request_count)} meta={m} />
          </Section>
          <Section title="Other activity">
            <ActivityList
              first={activity}
              budget={id}
              skipPayments
              empty="No pauses, funding or rule changes yet."
            />
          </Section>
        </div>
      </div>
    </div>
  );
}

function Rule({
  tone,
  title,
  children,
}: {
  tone: "green" | "amber" | "blue" | "gray";
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5 px-5 py-3.5">
      <Pill tone={tone}>{title}</Pill>
      <p className="text-muted">{children}</p>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2.5 px-5 py-3.5">
      <p className="text-sm font-medium text-muted">{title}</p>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}
