import type { Metadata } from "next";
import { SetupFlow } from "@/components/setup-flow";
import { getConfig } from "@/lib/near";

export const metadata: Metadata = { title: "Set up a budget · Earmark" };
export const dynamic = "force-dynamic";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** One short form that becomes the DAO proposals for a new budget. */
export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  const dao =
    one(q.dao) ??
    (await getConfig()
      .then((c) => c.dao_id)
      .catch(() => ""));
  const proposal = Number(one(q.proposal));
  const amount = one(q.amount);
  const resume =
    dao && Number.isInteger(proposal) && proposal >= 0 && one(q.proposal)
      ? { proposal, amount: amount && /^\d+$/.test(amount) ? amount : null }
      : null;

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Set up a budget for your DAO</h1>
        <p className="text-lg text-muted">
          Fill in one form. Earmark turns it into DAO proposals your council votes on.
        </p>
      </div>
      <SetupFlow initialDao={dao} resume={resume} />
    </div>
  );
}
