import Link from "next/link";
import { NETWORK, TRY_URL } from "@/lib/config";
import { getToken, listBudgets } from "@/lib/near";
import type { SpendRequest, Tier } from "@/lib/types";
import { RoutePicker } from "./route-picker";
import { ButtonLink } from "./ui";

const TILES: { tier: Tier; title: string; text: string; dot: string }[] = [
  { tier: "auto", title: "Paid at once", text: "Inside the lead’s limit", dot: "bg-emerald-500" },
  {
    tier: "one_approver",
    title: "One approval",
    text: "One council member signs",
    dot: "bg-amber-400",
  },
  {
    tier: "escalate",
    title: "DAO vote",
    text: "Too big: the whole DAO decides",
    dot: "bg-sky-500",
  },
];

const PAID = new Set(["paid", "paid_by_dao"]);

/**
 * The intro for visitors who aren't signed in: what Earmark does in one line, a picker that asks
 * the contract which path a payment would take, the replay of a real DAO, and how the demo
 * budget's real payments split across the three paths.
 */
export async function Landing({ requests }: { requests: [string, SpendRequest][] }) {
  const demo = await demoLead();
  return (
    <section className="space-y-6 pb-4">
      <div className="relative grid items-center gap-10 pt-2 lg:grid-cols-[1fr_23rem] lg:pt-6">
        <div
          aria-hidden
          className="dot-grid pointer-events-none absolute -inset-x-24 -top-16 -z-10 h-[30rem]"
        />
        <div className="rise max-w-2xl space-y-6">
          <span className="inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-1 text-sm font-medium text-muted ring-1 ring-line backdrop-blur">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            Team budgets for DAOs on NEAR
          </span>
          <h1 className="text-[2.6rem] font-semibold leading-[1.04] tracking-[-0.035em] sm:text-6xl">
            The DAO votes once.
            <br />
            <span className="text-gradient">Teams pay within limits.</span>
          </h1>
          <p className="max-w-xl text-lg text-muted">
            Small payments go out at once. Bigger ones need one approval. Anything larger goes to a
            normal DAO vote.
          </p>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 pt-1">
            <ButtonLink href={TRY_URL} className="h-12 px-6">
              {NETWORK === "mainnet" ? "Try it on testnet, no wallet" : "Try it, no wallet"}
            </ButtonLink>
            <Link href="/preview" className="font-semibold text-ink hover:text-brand">
              Replay a real DAO →
            </Link>
          </div>
          <p className="flex items-center gap-2 text-sm text-muted">
            <LockIcon />
            <span>
              The rules live in a contract with{" "}
              <Link
                href="/verify"
                className="font-medium text-ink underline-offset-2 hover:underline"
              >
                no admin key
              </Link>
              .
            </span>
          </p>
        </div>
        {demo && (
          <div className="rise relative [animation-delay:120ms]">
            <div
              aria-hidden
              className="absolute -inset-5 -z-10 rounded-[2rem] bg-gradient-to-br from-indigo-400/25 via-violet-300/20 to-emerald-300/25 blur-2xl"
            />
            <RoutePicker {...demo} />
          </div>
        )}
      </div>

      <div className="grid gap-4 pt-6 lg:grid-cols-5">
        {/* NEARWEEK's history is closed (last proposal Jun 2024), so these counts can't change;
            /preview recomputes them live from the DAO with the same two limits. */}
        <Link
          href="/preview"
          className="group relative overflow-hidden rounded-3xl bg-ink p-7 text-white shadow-card lg:col-span-3"
        >
          <div
            aria-hidden
            className="absolute -right-24 -top-24 size-72 rounded-full bg-indigo-500/30 blur-3xl"
          />
          <p className="relative text-sm font-medium text-indigo-200">A real DAO, replayed</p>
          <p className="tabular relative mt-3 flex items-baseline gap-3 font-semibold tracking-[-0.03em]">
            <span className="text-3xl text-white/35 line-through decoration-white/30 decoration-2 sm:text-4xl">
              13,896
            </span>
            <span className="text-2xl text-white/35">→</span>
            <span className="text-gradient-light text-6xl sm:text-7xl">20</span>
            <span className="text-lg text-white/70">votes</span>
          </p>
          <p className="relative mt-3 max-w-lg text-white/70">
            NEARWEEK’s council voted on every small payout from 2022 to 2024. With a 1 NEAR limit
            and one approval up to 5 NEAR, only 20 needed a vote. 121 repeat claims were blocked.
          </p>
          <span className="relative mt-6 inline-flex items-center gap-1.5 rounded-full bg-white/10 px-4 py-2 text-sm font-semibold ring-1 ring-white/15 transition-colors group-hover:bg-white/15">
            Replay it yourself
            <span className="transition-transform group-hover:translate-x-0.5">→</span>
          </span>
        </Link>

        <div className="rounded-3xl bg-white p-6 shadow-card ring-1 ring-line lg:col-span-2">
          <p className="text-sm font-medium text-muted">Demo budget so far</p>
          <ul className="mt-3 divide-y divide-line">
            {TILES.map((t) => {
              const paid = requests.filter(([, r]) => r.tier === t.tier && PAID.has(r.status));
              return (
                <li key={t.tier} className="flex items-center gap-3 py-3.5">
                  <span className={`size-2.5 shrink-0 rounded-full ${t.dot}`} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{t.title}</span>
                    <span className="block text-sm text-muted">{t.text}</span>
                  </span>
                  <span className="tabular text-2xl font-semibold tracking-tight">
                    {paid.length}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}

function LockIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="size-4 shrink-0 text-emerald-600"
      aria-hidden
    >
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

/**
 * The demo budget (first open one with a lead and payees) and its active lead with the most left
 * this period, so the picker's first answer is a payment that goes through.
 */
async function demoLead() {
  try {
    const b = (await listBudgets()).find(
      (x) => !x.closed && !x.paused && x.payees.length > 0 && x.spenders.some(([, l]) => !l.paused),
    );
    const left = (l: { period_cap: string; period_spent: string }) =>
      BigInt(l.period_cap) - BigInt(l.period_spent);
    const lead = b?.spenders
      .filter(([, l]) => !l.paused)
      .sort(([, x], [, y]) => (left(y) > left(x) ? 1 : left(y) < left(x) ? -1 : 0))[0]?.[0];
    if (!b || !lead) return null;
    return { budgetId: b.id, lead, payees: b.payees, meta: await getToken(b.token_id) };
  } catch {
    // No picker is better than a broken one.
    return null;
  }
}
