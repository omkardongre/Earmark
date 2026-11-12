// Telegram Bot API, the few calls the alerts need (docs/05 §6). Server only. The token comes
// from TELEGRAM_TOKEN (Secret Manager when hosted) and never reaches the browser or the logs.
import type { Message } from "./alerts";

export const telegramEnabled = () => !!process.env.TELEGRAM_TOKEN && !!process.env.TELEGRAM_BOT;
/** Alerts work here: a bot and somewhere to keep links (Firestore). Pages show the buttons then. */
export const alertsOn = () => telegramEnabled() && process.env.FIRESTORE === "1";
export const BOT = () => process.env.TELEGRAM_BOT ?? "";

/** Telegram asked us to slow down (429): stop this run, the next minute continues. */
export class RateLimited extends Error {}
/** The chat is gone for us (bot blocked, removed, chat deleted): drop its subscriptions. */
export class ChatGone extends Error {}

type Reply<T> = {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
};

async function api<T>(method: string, body: object): Promise<T> {
  const res = await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN?.trim()}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    },
  );
  const r = (await res.json().catch(() => ({ ok: false }))) as Reply<T>;
  if (r.ok && r.result !== undefined) return r.result;
  if (r.error_code === 429) throw new RateLimited(`retry after ${r.parameters?.retry_after}`);
  if (
    r.error_code === 403 ||
    /chat not found|bot was kicked|deactivated/i.test(r.description ?? "")
  ) {
    throw new ChatGone(r.description ?? "gone");
  }
  // An edit with the same text: nothing to change, which is fine.
  if (/message is not modified/i.test(r.description ?? "")) return undefined as T;
  throw new Error(`telegram ${method}: ${r.error_code} ${r.description}`);
}

const markup = (m: Message) =>
  m.button ? { inline_keyboard: [[{ text: m.button.text, url: m.button.url }]] } : undefined;

export async function send(chatId: number, m: Message, replyTo?: number): Promise<number> {
  const r = await api<{ message_id: number }>("sendMessage", {
    chat_id: chatId,
    text: m.text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: markup(m),
    ...(replyTo
      ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }
      : {}),
  });
  return r.message_id;
}

export async function edit(chatId: number, messageId: number, m: Message): Promise<void> {
  await api("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: m.text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: markup(m),
  });
}

/** Points the bot at this app (run once per deploy by `make alerts-setup`). */
export const setWebhook = (url: string, secret: string) =>
  api("setWebhook", {
    url,
    secret_token: secret,
    allowed_updates: ["message", "my_chat_member"],
    drop_pending_updates: true,
  });
