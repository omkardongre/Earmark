import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { esc } from "@/lib/alerts";
import { NETWORK } from "@/lib/config";
import { shortName } from "@/lib/format";
import { getBudget } from "@/lib/near";
import { store } from "@/lib/store";
import { ChatGone, send, telegramEnabled } from "@/lib/telegram";
import type { LinkCode } from "../alerts/link/route";

export const dynamic = "force-dynamic";

/** A chat that gets alerts: a whole budget (team group), or one payment or task (a DM). */
export type Sub = {
  network: string;
  chatId: number;
  budgetId: string;
  kind: "budget" | "watch";
  /** For a watch: "request:<id>" or "task:<id>". */
  target?: string;
};
/** A NEAR account linked to a Telegram user, for @mentions and DMs. */
export type Person = { network: string; account: string; userId: number; chatId: number };

type Update = {
  update_id: number;
  message?: {
    text?: string;
    chat: { id: number; type: string; title?: string };
    from?: { id: number; username?: string };
  };
  my_chat_member?: {
    chat: { id: number };
    new_chat_member: { status: string };
  };
};

function secretOk(req: Request): boolean {
  const want = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
  const got = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!want || want.length !== got.length) return false;
  return timingSafeEqual(Buffer.from(want), Buffer.from(got));
}

const HELP =
  "I post Earmark alerts: work to review, payments that need an approver, rule changes, and " +
  "“Paid”. Buttons open Earmark; your wallet signs there. I can’t approve or move money.\n" +
  "Get a link on a budget page (“Alerts in Telegram”). /stop ends alerts in this chat.";

async function reply(chatId: number, text: string) {
  try {
    await send(chatId, { text });
  } catch (e) {
    if (!(e instanceof ChatGone)) throw e;
  }
}

/** Removes every subscription of a chat (it said /stop, or the bot was removed). */
async function dropChat(chatId: number) {
  for (const s of await store.where<Sub>("subs", "chatId", chatId)) {
    if (s.data.network === NETWORK) await store.delete("subs", s.id);
  }
}

async function start(u: NonNullable<Update["message"]>, code: string) {
  const chatId = u.chat.id;
  const link = await store.take<LinkCode>("links", code);
  if (!link || link.expiresAt < Date.now() || link.network !== NETWORK) {
    return reply(chatId, "That link has expired. Get a new one in Earmark.");
  }
  if (link.kind === "group" && link.budgetId) {
    const b = await getBudget(link.budgetId).catch(() => null);
    await store.set<Sub>("subs", `${NETWORK}:${link.budgetId}:${chatId}`, {
      network: NETWORK,
      chatId,
      budgetId: link.budgetId,
      kind: "budget",
    });
    return reply(
      chatId,
      `This chat now gets Earmark alerts for <i>${esc(b?.name ?? `budget ${link.budgetId}`)}</i>.`,
    );
  }
  if (link.kind === "me" && link.account && u.from) {
    if (u.chat.type !== "private")
      return reply(chatId, "Open this link in a private chat with me.");
    await store.set<Person>("people", `${NETWORK}:${link.account}`, {
      network: NETWORK,
      account: link.account,
      userId: u.from.id,
      chatId,
    });
    return reply(
      chatId,
      `Linked to ${esc(shortName(link.account))}. Team alerts will mention you, and I’ll message you when something needs you.`,
    );
  }
  if (link.kind === "watch" && link.budgetId && (link.requestId || link.taskId)) {
    const target = link.requestId ? `request:${link.requestId}` : `task:${link.taskId}`;
    await store.set<Sub>("subs", `${NETWORK}:w:${target}:${chatId}`, {
      network: NETWORK,
      chatId,
      budgetId: link.budgetId,
      kind: "watch",
      target,
    });
    return reply(
      chatId,
      link.requestId
        ? "I’ll tell you when this payment is done."
        : "I’ll tell you about this task.",
    );
  }
  return reply(chatId, "That link doesn’t work. Get a new one in Earmark.");
}

/** Telegram's webhook (docs/05 §6.2). Checks the secret header first; replies 200 quickly. */
export async function POST(req: Request) {
  if (!telegramEnabled() || !secretOk(req)) return new NextResponse(null, { status: 401 });
  const u = (await req.json().catch(() => null)) as Update | null;
  if (!u) return NextResponse.json({ ok: true });
  try {
    const left = u.my_chat_member?.new_chat_member.status;
    if (u.my_chat_member && (left === "left" || left === "kicked")) {
      await dropChat(u.my_chat_member.chat.id);
    }
    const m = u.message;
    // "/start CODE" in a DM, "/start@Bot CODE" in a group.
    const [cmd, arg] = (m?.text ?? "").trim().split(/\s+/);
    const command = cmd?.split("@")[0];
    if (m && command === "/start") {
      if (arg && /^[A-Za-z0-9_-]{8,64}$/.test(arg)) await start(m, arg);
      else await reply(m.chat.id, HELP);
    } else if (m && command === "/stop") {
      await dropChat(m.chat.id);
      if (m.from && m.chat.type === "private") {
        for (const p of await store.where<Person>("people", "userId", m.from.id)) {
          if (p.data.network === NETWORK) await store.delete("people", p.id);
        }
      }
      await reply(m.chat.id, "Done. No more Earmark alerts here.");
    } else if (m && command === "/help") {
      await reply(m.chat.id, HELP);
    }
  } catch {
    // Telegram retries a non-2xx answer; a failed reply isn't worth a retry storm.
  }
  return NextResponse.json({ ok: true });
}
