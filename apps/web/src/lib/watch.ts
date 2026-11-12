// The alerts watcher (docs/05 §6.3), run every minute by Cloud Scheduler → /api/cron/alerts.
// For each open budget: read the chain fresh, compare with the last snapshot, post what changed,
// edit the first message of an item when it finishes, and remind once before a payment expires.
// No money moves here; a crash can repeat at most one message.
import type { Person, Sub } from "@/app/api/telegram/route";
import { describeChange } from "./activity";
import {
  type ChangeItem,
  type Ctx,
  diff,
  FINAL_REQUEST,
  type Item,
  key,
  type Message,
  message,
  needsReminder,
  type RequestItem,
  type Snapshot,
} from "./alerts";
import { CONTRACT, NETWORK, proposalUrl } from "./config";
import { getToken, viewRead } from "./near";
import { store } from "./store";
import { ChatGone, edit, RateLimited, send } from "./telegram";
import type { Budget, Config, QueuedChange, SpendRequest, Task } from "./types";

/** A live read, or an error: never the page cache's last-good value. */
async function fresh<T>(method: string, args: object): Promise<T> {
  const r = await viewRead<T>(CONTRACT, method, args);
  if (r.stale) throw new Error("stale read");
  return r.value;
}

const ns = (s: string) => Number(BigInt(s) / 1_000_000n);

async function readBudget(b: Budget, prev: Snapshot | null): Promise<Item[]> {
  const [requests, tasks, queued] = await Promise.all([
    fresh<[string, SpendRequest][]>("list_requests", { envelope_id: b.id, limit: 50 }),
    fresh<[string, Task][] | null>("list_tasks", { envelope_id: b.id, limit: 100 }).catch((e) => {
      // A contract from before tasks has no task views.
      if (/MethodNotFound|MethodResolveError/i.test(String(e))) return [];
      throw e;
    }),
    fresh<[string, QueuedChange][]>("list_queued", { envelope_id: b.id }),
  ]);
  const meta = await getToken(b.token_id);
  const byId = new Map(requests);
  // A waiting payment older than the newest 50 still counts.
  for (const id of b.pending_requests.filter((id) => !byId.has(id))) {
    const r = await fresh<SpendRequest | null>("get_request", { request_id: id });
    if (r) byId.set(id, r);
  }
  const ttl = Number(b.pending_ttl_secs) * 1000;
  const items: Item[] = [...byId].map(([id, r]) => ({
    kind: "request",
    id,
    status: r.status,
    amount: r.amount,
    payee: r.payee,
    spender: r.spender,
    work: r.work_ref,
    decidedBy: r.decided_by,
    expiresMs: ns(r.created_at_ns) + ttl,
    daoProposal: r.dao_proposal_id,
  }));
  for (const [id, t] of tasks ?? []) {
    items.push({
      kind: "task",
      id,
      status: t.status,
      title: t.title,
      amount: t.amount,
      claimant: t.claimant,
      lead: t.lead,
    });
  }
  const change = (id: string, c: QueuedChange): ChangeItem => ({
    kind: "change",
    id,
    status: c.status,
    text: describeChange(c.change, meta),
    by: c.queued_by,
    effectiveMs: ns(c.effective_at_ns),
  });
  const open = new Set(queued.map(([id]) => id));
  items.push(...queued.map(([id, c]) => change(id, c)));
  // A change that left the queue: read how it ended (applied, cancelled or stale).
  for (const k of Object.keys(prev ?? {})) {
    if (!k.startsWith("change:") || prev?.[k] !== "queued") continue;
    const id = k.slice("change:".length);
    if (open.has(id)) continue;
    const c = await fresh<QueuedChange | null>("get_change", { change_id: id });
    if (c) items.push(change(id, c));
  }
  return items;
}

type Thread = { posts: { chatId: number; messageId: number }[]; reminded?: boolean };
const threadId = (i: Item) => `${NETWORK}:${key(i)}`;

export type RunReport = { budgets: number; sent: number; edited: number; errors: string[] };

export async function runAlerts(app: string): Promise<RunReport> {
  const report: RunReport = { budgets: 0, sent: 0, edited: 0, errors: [] };
  const subs = (await store.where<Sub>("subs", "network", NETWORK)).map((s) => s.data);
  const people = (await store.where<Person>("people", "network", NETWORK)).map((p) => p.data);
  if (subs.length === 0 && people.length === 0) return report;
  const mentions = new Map(people.map((p) => [p.account, p.userId]));
  const dmChat = new Map(people.map((p) => [p.account, p.chatId]));
  const config = await fresh<Config>("get_config", {});
  const budgets = (await fresh<Budget[]>("list_envelopes", {})).filter((b) => !b.closed);

  const gone = new Set<number>();
  /** Sends, or skips a chat that's gone; RateLimited stops the run. */
  const post = async (chatId: number, m: Message, replyTo?: number) => {
    if (gone.has(chatId)) return null;
    try {
      const id = await send(chatId, m, replyTo);
      report.sent++;
      return id;
    } catch (e) {
      if (e instanceof ChatGone) {
        gone.add(chatId);
        return null;
      }
      throw e;
    }
  };

  try {
    for (const b of budgets) {
      const snapId = `${NETWORK}:${b.id}`;
      const prev = (await store.get<{ items: Snapshot }>("snapshots", snapId))?.items ?? null;
      let items: Item[];
      try {
        items = await readBudget(b, prev);
      } catch (e) {
        // Skip this budget this minute: no message, no snapshot change.
        report.errors.push(`budget ${b.id}: ${e instanceof Error ? e.message : e}`);
        continue;
      }
      report.budgets++;
      const meta = await getToken(b.token_id);
      const ctx: Ctx = {
        app,
        budgetId: b.id,
        budgetName: b.name,
        meta,
        approvers: b.approvers,
        mentions,
        trezu: (p) => proposalUrl(config.dao_id, p),
      };
      const groups = subs.filter((s) => s.kind === "budget" && s.budgetId === b.id);
      const { changes, next } = diff(prev, items);
      // Saved as each item is handled, so a stop halfway doesn't post the done ones again.
      const saved: Snapshot = { ...(prev ?? next) };
      const save = () => store.set("snapshots", snapId, { items: saved, updatedAt: Date.now() });

      for (const c of changes) {
        const tid = threadId(c.item);
        const thread = (await store.get<Thread>("messages", tid)) ?? { posts: [] };
        const out = message(c, ctx, thread.posts.length > 0);
        if (out) {
          for (const g of groups) {
            const mine = thread.posts.filter((p) => p.chatId === g.chatId);
            if (out.kind === "edit" && mine.length > 0) {
              for (const p of mine) {
                try {
                  await edit(p.chatId, p.messageId, out.msg);
                  report.edited++;
                } catch (e) {
                  if (!(e instanceof ChatGone)) throw e;
                  gone.add(p.chatId);
                }
              }
            } else {
              const id = await post(g.chatId, out.msg);
              if (id) thread.posts.push({ chatId: g.chatId, messageId: id });
            }
          }
          // DMs: people who linked their account and are named, plus anyone watching this item.
          const final = c.item.kind === "request" && FINAL_REQUEST.includes(c.item.status);
          const dms = new Set<number>();
          for (const a of out.msg.dm ?? []) {
            const chat = dmChat.get(a);
            if (chat) dms.add(chat);
          }
          if (final || c.item.kind === "task") {
            for (const s of subs) {
              if (s.kind === "watch" && s.target === key(c.item)) dms.add(s.chatId);
            }
          }
          for (const g of groups) dms.delete(g.chatId);
          for (const chat of dms) await post(chat, out.msg);
          await store.set("messages", tid, thread);
        }
        saved[key(c.item)] = c.item.status;
        await save();
      }

      // One reminder, as a reply in each team chat, before a waiting payment expires.
      const now = Date.now();
      for (const i of items) {
        if (i.kind !== "request" || i.status !== "pending_approval") continue;
        const tid = threadId(i);
        const thread = await store.get<Thread>("messages", tid);
        if (!thread || !needsReminder(i as RequestItem, now, !!thread.reminded)) continue;
        for (const p of thread.posts) {
          await post(
            p.chatId,
            { text: "⏰ Expires in less than 6 h. It still needs 1 approver." },
            p.messageId,
          );
        }
        thread.reminded = true;
        await store.set("messages", tid, thread);
      }

      for (const k of Object.keys(next)) saved[k] = next[k] as string;
      // Only write when something moved: one write a minute per budget would add up.
      if (JSON.stringify(saved) !== JSON.stringify(prev)) await save();
    }
  } catch (e) {
    if (!(e instanceof RateLimited)) throw e;
    report.errors.push("telegram rate limit: stopped, next run continues");
  } finally {
    for (const chatId of gone) {
      for (const s of await store.where<Sub>("subs", "chatId", chatId)) {
        await store.delete("subs", s.id);
      }
    }
  }
  return report;
}
