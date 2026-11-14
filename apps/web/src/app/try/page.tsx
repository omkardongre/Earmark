import { redirect } from "next/navigation";
import { TryPanel } from "@/components/try-panel";
import { Disclosure, Empty, ExternalLink } from "@/components/ui";
import { accountUrl, NETWORK, TRY_URL } from "@/lib/config";
import { display } from "@/lib/fonts";
import { units } from "@/lib/format";
import { amounts, getTryBudget, TRY, tryEnabled } from "@/lib/try";

export const dynamic = "force-dynamic";

const META = { symbol: "tUSDC", decimals: 6 };

/** No-wallet sandbox: a visitor plays the team lead of a small testnet budget. */
export default async function TryPage() {
  // The sandbox and its keys are on testnet; the mainnet app sends visitors there.
  if (NETWORK === "mainnet") redirect(TRY_URL);
  const budget = tryEnabled() ? await getTryBudget().catch(() => null) : null;
  const limit = budget?.spenders[0]?.[1].auto_limit;

  return (
    <div className={`${display.className} relative mx-auto max-w-3xl space-y-8`}>
      <div
        aria-hidden
        className="dot-grid pointer-events-none absolute -inset-x-24 -top-16 -z-10 h-[24rem]"
      />
      <div className="rise grid items-end gap-6 sm:grid-cols-[1fr_15rem]">
        <div className="space-y-3">
          <span className="inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-1 text-sm font-medium text-muted ring-1 ring-line backdrop-blur">
            <span className="relative flex size-2">
              <span className="live-ping absolute inline-flex size-full rounded-full bg-emerald-400" />
              <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
            </span>
            Real testnet transactions
          </span>
          <h1 className="text-4xl font-semibold leading-[1.05] tracking-[-0.035em] sm:text-5xl">
            Try it. <span className="text-gradient">No wallet.</span>
          </h1>
          <p className="text-muted">
            You lead a team with a small test budget. Press a button, and the contract on NEAR
            answers.
          </p>
        </div>
        {budget && (
          <div className="relative overflow-hidden rounded-3xl bg-ink p-5 text-white shadow-card">
            <div
              aria-hidden
              className="absolute -right-16 -top-16 size-44 rounded-full bg-indigo-500/30 blur-3xl"
            />
            <p className="relative text-sm font-medium text-indigo-200">Your test budget</p>
            <p className="tabular relative mt-1 flex items-baseline gap-1.5 font-semibold tracking-[-0.03em]">
              <span className="text-gradient-light text-5xl">{units(budget.available, META)}</span>
              <span className="text-lg text-white/50">tUSDC left</span>
            </p>
            <dl className="relative mt-3 space-y-1.5 text-sm">
              <Limit
                dot="bg-emerald-400"
                label="Paid at once"
                value={limit ? `up to ${units(limit, META)}` : "–"}
              />
              <Limit
                dot="bg-amber-400"
                label="One approval"
                value={`up to ${units(budget.one_approver_limit, META)}`}
              />
            </dl>
          </div>
        )}
      </div>
      {!budget ? (
        <Empty>The sandbox isn’t available right now. Please try again later.</Empty>
      ) : (
        <div className="rise [animation-delay:120ms]">
          <TryPanel {...amounts(budget)} />
        </div>
      )}
      <Disclosure title="What the demo keys can do">
        <div className="space-y-2 px-5 py-4 text-muted">
          <p>
            The server holds two testnet keys for{" "}
            <ExternalLink href={accountUrl(TRY.contract)}>{TRY.contract}</ExternalLink>. The lead’s
            key can only call <code>request_spend</code>. The council member’s key can only call{" "}
            <code>approve</code> and <code>expire</code>.
          </p>
          <p>
            The sandbox runs the same contract code as the main demo, and its account has no keys.
            Only the DAO can change it. The race and the pause use two more small budgets, so this
            one stays open for everyone.
          </p>
        </div>
      </Disclosure>
    </div>
  );
}

function Limit({ dot, label, value }: { dot: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span aria-hidden className={`size-2 rounded-full ${dot}`} />
      <dt className="flex-1 text-white/70">{label}</dt>
      <dd className="tabular font-medium">{value}</dd>
    </div>
  );
}
