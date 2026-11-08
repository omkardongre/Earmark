// Rows of the activity feed: the newest page (to refresh after an action) or older rows for
// "Show more" (with a cursor). Read-only, public data.
import { NextResponse } from "next/server";
import { loadActivity, loadBase } from "@/lib/data";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const cursor = q.get("cursor") ?? undefined;
  const budget = q.get("budget") ?? undefined;
  const account = q.get("account") ?? undefined;
  const skip = q.get("skip");
  if (
    (cursor !== undefined && !/^\d{1,30}$/.test(cursor)) ||
    (budget !== undefined && !/^\d{1,20}$/.test(budget)) ||
    (account !== undefined && !/^[a-z0-9._-]{2,64}$/.test(account)) ||
    (skip !== null && skip !== "payments" && skip !== "changes")
  ) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const page = await loadActivity(await loadBase(), {
    cursor,
    budget,
    account,
    skipPayments: skip === "payments",
    skipChanges: skip === "changes",
  });
  return NextResponse.json(page, { headers: { "Cache-Control": "no-store" } });
}
