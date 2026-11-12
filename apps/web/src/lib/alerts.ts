// Telegram alerts (feature 4, docs/05 §6): what changed since the last look, and what to say.
// Pure functions, no network, unit tested in alerts.test.ts. The watcher (cron/alerts) reads the
// chain, calls `diff`, and turns each event into Telegram sends and edits.
import { money, shortName } from "./format";
import type { RequestStatus, TaskStatus, TokenMeta } from "./types";

export type RequestItem = {
  kind: "request";
  id: string;
  status: RequestStatus;
  amount: string;
  payee: string;
  spender: string;
  work: string;
  decidedBy: string | null;
  expiresMs: number;
  daoProposal: string | null;
};
export type TaskItem = {
  kind: "task";
  id: string;
  status: TaskStatus;
  title: string;
  amount: string;
  claimant: string | null;
  lead: string;
};
export type ChangeItem = {
  kind: "change";
  id: string;
  status: "queued" | "applied" | "cancelled" | "stale";
  text: string;
  by: string;
  effectiveMs: number;
};
export type Item = RequestItem | TaskItem | ChangeItem;

/** `kind:id` → last status seen. */
export type Snapshot = Record<string, string>;
export type Change = { item: Item; from: string | null };

export const key = (i: Pick<Item, "kind" | "id">) => `${i.kind}:${i.id}`;

/**
 * Items whose status is new or changed. With no snapshot yet (a new subscription), nothing: the
 * first look only records where things stand, so a new chat isn't flooded with old items.
 */
export function diff(prev: Snapshot | null, items: Item[]): { changes: Change[]; next: Snapshot } {
  const next: Snapshot = { ...(prev ?? {}) };
  const changes: Change[] = [];
  for (const item of items) {
    const k = key(item);
    const from = prev?.[k] ?? null;
    next[k] = item.status;
    if (prev && from !== item.status) changes.push({ item, from });
  }
  return { changes, next };
}

/** Final request states: no more action, and the thread's last word. */
export const FINAL_REQUEST: RequestStatus[] = [
  "paid",
  "paid_by_dao",
  "rejected",
  "expired",
  "failed",
  "escalation_closed",
];

/** People the bot can @mention: account → Telegram user id (from "Mention me"). */
export type Mentions = Map<string, number>;
export type Button = { text: string; url: string };
/** One message: HTML text, an optional button, and the accounts who should get it in a DM. */
export type Message = { text: string; button?: Button; dm?: string[] };

export type Ctx = {
  app: string;
  budgetId: string;
  budgetName: string;
  meta: TokenMeta;
  approvers: string[];
  mentions: Mentions;
  trezu: (proposal: string) => string;
};

export const esc = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** A name, as an @mention when that person linked their Telegram account. */
function who(account: string, mentions: Mentions): string {
  const name = esc(shortName(account));
  const id = mentions.get(account);
  return id ? `<a href="tg://user?id=${id}">${name}</a>` : name;
}

/** "Fri 14 Nov, 14:00 UTC". */
export function when(ms: number): string {
  const d = new Date(ms);
  const day = d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  const time = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
  return `${day.replace(",", "")}, ${time} UTC`;
}

/**
 * What to post for one change: a new message, an edit of the item's first message, or nothing.
 * `hasThread` says whether the item already has a message to edit.
 */
export function message(
  c: Change,
  ctx: Ctx,
  hasThread: boolean,
): { kind: "send" | "edit"; msg: Message } | null {
  const { item } = c;
  const m = (amount: string) => esc(money(amount, ctx.meta));
  const budget = `<i>${esc(ctx.budgetName)}</i>`;
  if (item.kind === "request") {
    const r = item;
    const open = { text: "Open payment", url: `${ctx.app}/payments/${r.id}` };
    const final = (text: string, dm: string[]) =>
      ({ kind: hasThread ? "edit" : "send", msg: { text, button: open, dm } }) as const;
    switch (r.status) {
      case "pending_approval": {
        const approvers = ctx.approvers.filter((a) => a !== r.spender);
        return {
          kind: "send",
          msg: {
            text:
              `✋ ${m(r.amount)} to ${who(r.payee, ctx.mentions)} from ${budget}. ` +
              `Needs 1 approver: ${approvers.map((a) => who(a, ctx.mentions)).join(", ")}.\n` +
              `Asked by ${who(r.spender, ctx.mentions)}. Expires ${when(r.expiresMs)}.`,
            // The approval card (with the budget context and Approve) is on the Approvals tab.
            button: { text: "Review payment", url: `${ctx.app}/approvals#pay-${r.id}` },
            dm: approvers,
          },
        };
      }
      case "paid":
      case "paid_by_dao":
        return final(`✅ Paid ${m(r.amount)} to ${who(r.payee, ctx.mentions)} from ${budget}.`, [
          r.payee,
        ]);
      case "rejected":
        return hasThread
          ? final(
              `✖ Not paid: ${m(r.amount)} to ${who(r.payee, ctx.mentions)}. Rejected${r.decidedBy ? ` by ${who(r.decidedBy, ctx.mentions)}` : ""}.`,
              [r.payee, r.spender],
            )
          : null;
      case "expired":
        return hasThread
          ? final(
              `✖ Not paid: ${m(r.amount)} to ${who(r.payee, ctx.mentions)}. Nobody approved it in time.`,
              [r.payee, r.spender],
            )
          : null;
      case "failed":
        return final(
          `⚠️ Payment failed: ${m(r.amount)} to ${who(r.payee, ctx.mentions)}. The money is back in ${budget}.`,
          [r.payee, r.spender],
        );
      case "escalation_closed":
        return hasThread
          ? final(
              `✖ Not paid: the DAO didn't pay ${m(r.amount)} to ${who(r.payee, ctx.mentions)}.`,
              [r.payee],
            )
          : null;
      case "escalated":
        return {
          kind: hasThread ? "edit" : "send",
          msg: {
            text: `🗳 ${m(r.amount)} to ${who(r.payee, ctx.mentions)} from ${budget} needs a DAO vote.`,
            button: r.daoProposal ? { text: "Open the vote", url: ctx.trezu(r.daoProposal) } : open,
          },
        };
      case "dao_funded":
        return {
          kind: hasThread ? "edit" : "send",
          msg: {
            text: `💰 The DAO paid in ${m(r.amount)} for ${who(r.payee, ctx.mentions)}. Anyone can finish the payout.`,
            button: { text: "Finish payout", url: open.url },
          },
        };
      default:
        return null;
    }
  }
  if (item.kind === "task") {
    const t = item;
    const open = { text: "Review work", url: `${ctx.app}/budgets/${ctx.budgetId}/tasks/${t.id}` };
    const by = t.claimant ? who(t.claimant, ctx.mentions) : "Someone";
    const title = `<i>${esc(t.title)}</i>`;
    if (t.status === "submitted") {
      return {
        kind: "send",
        msg: {
          text: `📝 ${by} sent work for ${title} (${m(t.amount)}). ${who(t.lead, ctx.mentions)} to review.`,
          button: open,
          dm: [t.lead],
        },
      };
    }
    if (!hasThread || c.from !== "submitted") return null;
    const text =
      t.status === "claimed"
        ? `↩ ${who(t.lead, ctx.mentions)} asked for changes to ${title}.`
        : t.status === "open"
          ? `✖ ${who(t.lead, ctx.mentions)} turned down the work for ${title}. The task is open again.`
          : t.status === "cancelled"
            ? `✖ ${title} was cancelled.`
            : `✓ ${who(t.lead, ctx.mentions)} accepted the work for ${title}.`;
    return { kind: "edit", msg: { text, button: { text: "Open task", url: open.url } } };
  }
  const ch = item;
  const review = { text: "Review or cancel", url: `${ctx.app}/approvals` };
  if (ch.status === "queued") {
    const approvers = ctx.approvers.filter((a) => a !== ch.by);
    return {
      kind: "send",
      msg: {
        text:
          `⚠️ ${who(ch.by, ctx.mentions)} asked: ${esc(ch.text)} (${budget}).\n` +
          `Can be applied after ${when(ch.effectiveMs)}. Any approver can cancel it before then.`,
        button: review,
        dm: approvers,
      },
    };
  }
  if (!hasThread) return null;
  const done =
    ch.status === "applied" ? "Now in effect" : ch.status === "cancelled" ? "Cancelled" : "Expired";
  return { kind: "edit", msg: { text: `${done}: ${esc(ch.text)} (${budget}).` } };
}

/** A waiting payment gets one reminder this long before it expires. */
export const REMIND_MS = 6 * 3600 * 1000;

export function needsReminder(r: RequestItem, now: number, reminded: boolean): boolean {
  return (
    r.status === "pending_approval" &&
    !reminded &&
    r.expiresMs > now &&
    r.expiresMs - now <= REMIND_MS
  );
}
