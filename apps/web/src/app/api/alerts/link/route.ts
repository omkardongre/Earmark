import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { CONTRACT, NETWORK } from "@/lib/config";
import { getBudget, getRequest, getTask } from "@/lib/near";
import { persistent, store } from "@/lib/store";
import { BOT, telegramEnabled } from "@/lib/telegram";

export const dynamic = "force-dynamic";

/** A one-time code for `t.me/<bot>?start=<code>` (docs/05 §6.2). Expires in an hour. */
export type LinkCode = {
  kind: "group" | "me" | "watch";
  network: string;
  contract: string;
  budgetId?: string;
  requestId?: string;
  taskId?: string;
  account?: string;
  expiresAt: number;
};

const id = /^[a-z0-9._-]{2,64}$/;
const seen = new Map<string, number[]>();
/** At most 20 codes a minute per visitor: they're cheap, but the store isn't a toy. */
function allow(visitor: string): boolean {
  const now = Date.now();
  const recent = (seen.get(visitor) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= 20) return false;
  seen.set(visitor, [...recent, now]);
  return true;
}

/**
 * POST { kind, budgetId? | requestId? | taskId?, account? } → { url }.
 * - group: add the bot to a team chat for a budget's alerts;
 * - me: link the signed-in NEAR account to your Telegram user (mentions and DMs);
 * - watch: get one message when a payment or task finishes.
 * Alerts carry only public chain data and the bot can't act, so no wallet signature is asked.
 */
export async function POST(req: Request) {
  if (!telegramEnabled() || !persistent()) {
    return NextResponse.json({ error: "Telegram alerts aren’t set up here." }, { status: 503 });
  }
  const visitor = req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || "local";
  if (!allow(visitor)) {
    return NextResponse.json({ error: "Too many links. Wait a minute." }, { status: 429 });
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : undefined);
  const kind = str("kind");
  const code: LinkCode = {
    kind: kind as LinkCode["kind"],
    network: NETWORK,
    contract: CONTRACT,
    expiresAt: Date.now() + 3600_000,
  };
  if (kind === "group") {
    const b = str("budgetId");
    if (!b || !/^\d{1,20}$/.test(b) || !(await getBudget(b).catch(() => null))) {
      return NextResponse.json({ error: "No such budget." }, { status: 400 });
    }
    code.budgetId = b;
  } else if (kind === "me") {
    const a = str("account");
    if (!a || !id.test(a)) return NextResponse.json({ error: "Sign in first." }, { status: 400 });
    code.account = a;
  } else if (kind === "watch") {
    const r = str("requestId");
    const t = str("taskId");
    if (r && id.test(r)) {
      const got = await getRequest(r).catch(() => null);
      if (!got) return NextResponse.json({ error: "No such payment." }, { status: 400 });
      code.requestId = r;
      code.budgetId = got.envelope_id;
    } else if (t && /^\d{1,20}$/.test(t)) {
      const got = await getTask(t).catch(() => null);
      if (!got) return NextResponse.json({ error: "No such task." }, { status: 400 });
      code.taskId = t;
      code.budgetId = got.envelope_id;
    } else {
      return NextResponse.json({ error: "Nothing to watch." }, { status: 400 });
    }
  } else {
    return NextResponse.json({ error: "Unknown link." }, { status: 400 });
  }
  // 12 random bytes = 16 base64url characters, inside Telegram's 64-character start limit.
  const c = randomBytes(12).toString("base64url");
  await store.set("links", c, code);
  const param = kind === "group" ? "startgroup" : "start";
  return NextResponse.json({ url: `https://t.me/${BOT()}?${param}=${c}` });
}
