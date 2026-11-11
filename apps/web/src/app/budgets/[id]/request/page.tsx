import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RequestForm } from "@/components/request-form";
import { Card } from "@/components/ui";
import { loadBase } from "@/lib/data";

export const metadata: Metadata = { title: "Ask to be paid · Earmark" };
export const dynamic = "force-dynamic";

/** A contributor asks a budget's lead for a payment: the form becomes a link for the lead. */
export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();
  const base = await loadBase();
  const b = base.budgets.find((x) => x.id === id);
  const m = base.meta.get(id);
  if (!b || !m) notFound();

  return (
    <div className="mx-auto max-w-md space-y-6">
      <div className="space-y-1">
        <Link href={`/budgets/${b.id}`} className="text-muted hover:text-ink">
          ← {b.name}
        </Link>
        <h1 className="text-3xl font-bold tracking-tight">Ask to be paid</h1>
        <p className="text-muted">Your lead gets a link with the pay form filled in.</p>
      </div>
      <Card className="p-6">
        {b.closed || b.payees.length === 0 ? (
          <p className="text-muted">
            {b.closed ? "This budget is closed." : "No one can be paid from this budget yet."}
          </p>
        ) : (
          <RequestForm budgetId={b.id} budgetName={b.name} payees={b.payees} meta={m} />
        )}
      </Card>
    </div>
  );
}
