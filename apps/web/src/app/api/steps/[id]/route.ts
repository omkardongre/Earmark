// The steps of one payment (its events, oldest first), for the payment page to fill in when the
// history indexer hadn't caught up yet at first render. Read-only, public data.
import { NextResponse } from "next/server";
import { requestEvents } from "@/lib/data";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(id)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const events = await requestEvents(id);
  if (events === null) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  return NextResponse.json(events, { headers: { "Cache-Control": "no-store" } });
}
