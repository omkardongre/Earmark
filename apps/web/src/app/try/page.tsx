import { TryPanel } from "@/components/try-panel";
import { Card, Disclosure, Empty, ExternalLink } from "@/components/ui";
import { redirect } from "next/navigation";
import { accountUrl, NETWORK, TRY_URL } from "@/lib/config";
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
    <div className="mx-auto max-w-2xl space-y-8">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Try it, no wallet</h1>
        <p className="text-lg text-muted">
          You lead a team with a small test budget. Each button sends a real testnet transaction.
        </p>
      </div>

      {!budget ? (
        <Empty>The sandbox isn’t available right now. Please try again later.</Empty>
      ) : (
        <>
          <Card className="grid grid-cols-3 divide-x divide-line">
            <Stat label="tUSDC left" value={units(budget.available, META)} />
            <Stat label="paid at once" value={limit ? `≤ ${units(limit, META)}` : "–"} />
            <Stat label="one approval" value={`≤ ${units(budget.one_approver_limit, META)}`} />
          </Card>
          <TryPanel {...amounts(budget)} />
        </>
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-4 py-4 sm:px-6">
      <p className="tabular text-lg font-bold tracking-tight sm:text-2xl">{value}</p>
      <p className="text-sm text-muted">{label}</p>
    </div>
  );
}
