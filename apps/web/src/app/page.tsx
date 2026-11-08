import Link from "next/link";
import { ActivityList } from "@/components/activity-list";
import { BudgetCard } from "@/components/budget-card";
import { Landing } from "@/components/landing";
import { SignedOut } from "@/components/signed-out";
import { Disclosure, Empty, ExternalLink, Section } from "@/components/ui";
import { accountUrl } from "@/lib/config";
import { loadActivity, loadBase } from "@/lib/data";
import { listRequests } from "@/lib/near";

export const dynamic = "force-dynamic";

export default async function Home() {
  const base = await loadBase();
  const { config, budgets, meta } = base;
  const open = budgets.filter((b) => !b.closed);
  const closed = budgets.filter((b) => b.closed);
  const [activity, requests] = await Promise.all([
    loadActivity(base),
    Promise.all(open.map((b) => listRequests(b.id, { limit: 100 }))).then((l) => l.flat()),
  ]);

  return (
    <div className="space-y-10">
      <SignedOut>
        <Landing requests={requests} meta={meta.values().next().value} />
      </SignedOut>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-2xl font-bold tracking-tight">Budgets</h2>
        <Link href="/setup" className="text-[15px] font-medium text-brand hover:underline">
          New budget
        </Link>
      </div>

      {open.length === 0 ? (
        <Empty>
          No budgets yet.{" "}
          <Link href="/setup" className="font-medium text-brand hover:underline">
            Set one up
          </Link>{" "}
          and the DAO votes on it.
        </Empty>
      ) : (
        <div className={`grid gap-4 ${open.length > 1 ? "md:grid-cols-2" : ""}`}>
          {open.map((b) => {
            const m = meta.get(b.id);
            return m ? <BudgetCard key={b.id} b={b} m={m} /> : null;
          })}
        </div>
      )}
      {closed.length > 0 && (
        <p className="text-muted">
          Closed:{" "}
          {closed.map((b, i) => (
            <span key={b.id}>
              {i > 0 && ", "}
              <Link href={`/budgets/${b.id}`} className="hover:underline">
                {b.name}
              </Link>
            </span>
          ))}
        </p>
      )}

      <Section title="Recent activity">
        <ActivityList first={activity} empty="No payments yet. Make the first one above." />
      </Section>

      <Disclosure title="How it works">
        <div className="space-y-2 px-5 py-4 text-muted">
          <p>
            The DAO gives each team a budget once. Small payments go out at once, bigger ones need
            one approval, and anything larger goes to a normal DAO vote.
          </p>
          <p>
            DAO: <ExternalLink href={accountUrl(config.dao_id)}>{config.dao_id}</ExternalLink>
          </p>
          <p>
            <Link href="/verify" className="font-medium text-brand hover:underline">
              Check the contract yourself
            </Link>
            : no admin keys, code changes only by DAO vote, balances add up.
          </p>
        </div>
      </Disclosure>
    </div>
  );
}
