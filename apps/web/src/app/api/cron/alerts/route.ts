import { randomUUID, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { NETWORK } from "@/lib/config";
import { persistent, store } from "@/lib/store";
import { telegramEnabled } from "@/lib/telegram";
import { runAlerts } from "@/lib/watch";

export const dynamic = "force-dynamic";
// One run reads a few views per budget and sends a few messages.
export const maxDuration = 60;

function secretOk(req: Request): boolean {
  const want = process.env.CRON_SECRET ?? "";
  const got = req.headers.get("x-cron-secret") ?? "";
  if (!want || want.length !== got.length) return false;
  return timingSafeEqual(Buffer.from(want), Buffer.from(got));
}

/**
 * POST from Cloud Scheduler every minute (header x-cron-secret). The service is public, so the
 * header is the check. A lease stops two runs overlapping when a run is slow.
 */
export async function POST(req: Request) {
  if (!secretOk(req)) return new NextResponse(null, { status: 401 });
  if (!telegramEnabled() || !persistent()) {
    return NextResponse.json({ error: "Telegram alerts aren’t set up here." }, { status: 503 });
  }
  const holder = randomUUID();
  if (!(await store.lease(`alerts:${NETWORK}`, holder, 55_000))) {
    return NextResponse.json({ skipped: "another run is going" });
  }
  const app = process.env.APP_URL ?? new URL(req.url).origin;
  try {
    return NextResponse.json(await runAlerts(app));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  } finally {
    await store.lease(`alerts:${NETWORK}`, holder, 0);
  }
}
