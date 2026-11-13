import { NextResponse } from "next/server";
import { NETWORK } from "@/lib/config";
import { persistent, store } from "@/lib/store";
import { alertsOn } from "@/lib/telegram";
import type { Sub } from "../../telegram/route";

export const dynamic = "force-dynamic";

/**
 * GET ?budgetId=0 → { chats: n }: how many team chats get this budget's alerts, so the budget
 * page can say "Connected". Only a count: chat names and ids stay private.
 */
export async function GET(req: Request) {
  const budgetId = new URL(req.url).searchParams.get("budgetId") ?? "";
  if (!/^\d{1,10}$/.test(budgetId))
    return NextResponse.json({ error: "bad budget" }, { status: 400 });
  if (!alertsOn() || !persistent()) return NextResponse.json({ chats: 0 });
  try {
    const subs = await store.where<Sub>("subs", "budgetId", budgetId);
    const chats = subs.filter((s) => s.data.network === NETWORK && s.data.kind === "budget").length;
    return NextResponse.json({ chats });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
