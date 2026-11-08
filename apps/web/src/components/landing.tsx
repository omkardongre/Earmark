import Link from "next/link";
import { NETWORK, TRY_URL } from "@/lib/config";
import { money, shortName } from "@/lib/format";
import { getToken, listBudgets } from "@/lib/near";
import type { SpendRequest, Tier, TokenMeta } from "@/lib/types";
import { RoutePicker } from "./route-picker";
import { ButtonLink } from "./ui";

const TILES: { tier: Tier; title: string; text: string }[] = [
  { tier: "auto", title: "Paid at once", text: "Inside the lead’s limit" },
  { tier: "one_approver", title: "One approval", text: "One council member signs" },
  { tier: "escalate", title: "DAO vote", text: "Too big: the whole DAO decides" },
];

const PAID = new Set(["paid", "paid_by_dao"]);

/**
 * The intro for visitors who aren't signed in: what Earmark does in one line, how the demo
 * budget's real payments split across the three paths, a picker that asks the contract which path a
 * payment would take, and two ways to try it.
 */
export async function Landing({
  requests,
  meta,
}: {
  requests: [string, SpendRequest][];
  meta: TokenMeta | undefined;
}) {
  const demo = await demoLead();
  return (
    <section className="space-y-8 pb-4">
      <div className="grid items-center gap-8 lg:grid-cols-[1fr_22rem]">
        <div className="max-w-2xl space-y-4">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            The DAO votes once. Teams pay contributors within limits.
          </h1>
          <p className="text-lg text-muted">
            Small payments go out at once, bigger ones need one approval, and anything larger goes
            to a normal DAO vote. The rules live in a contract that has{" "}
            <Link href="/verify" className="font-medium text-brand hover:underline">
              no admin key
            </Link>
            .
          </p>
          <div className="flex flex-wrap gap-3 pt-1">
            <ButtonLink href={TRY_URL}>
              {NETWORK === "mainnet" ? "Try it on testnet, no wallet" : "Try it, no wallet"}
            </ButtonLink>
            <ButtonLink href="/preview" variant="secondary">
              Replay a real DAO’s history
            </ButtonLink>
          </div>
        </div>
        {demo && <RoutePicker {...demo} />}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {TILES.map((t) => {
          const paid = requests.filter(([, r]) => r.tier === t.tier && PAID.has(r.status));
          const latest = paid[0];
          return (
            <div key={t.tier} className="rounded-2xl bg-white p-5 ring-1 ring-line">
              <p className="tabular text-3xl font-bold tracking-tight">{paid.length}</p>
              <p className="font-semibold">{t.title}</p>
              <p className="text-sm text-muted">{t.text}</p>
              {latest && meta && (
                <Link
                  href={`/payments/${encodeURIComponent(latest[0])}`}
                  className="mt-3 block text-sm font-medium text-brand hover:underline"
                >
                  Latest: {money(latest[1].amount, meta)} to {shortName(latest[1].payee)} →
                </Link>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** The demo budget (first open one with a lead and payees) and its first active lead. */
async function demoLead() {
  try {
    const b = (await listBudgets()).find(
      (x) => !x.closed && !x.paused && x.payees.length > 0 && x.spenders.some(([, l]) => !l.paused),
    );
    const lead = b?.spenders.find(([, l]) => !l.paused)?.[0];
    if (!b || !lead) return null;
    return { budgetId: b.id, lead, payees: b.payees, meta: await getToken(b.token_id) };
  } catch {
    // No picker is better than a broken one.
    return null;
  }
}
