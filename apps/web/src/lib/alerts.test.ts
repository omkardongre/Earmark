import { describe, expect, it } from "vitest";
import { type Ctx, diff, esc, type Item, message, needsReminder, type RequestItem } from "./alerts";

const req = (status: RequestItem["status"], over: Partial<RequestItem> = {}): RequestItem => ({
  kind: "request",
  id: "r1",
  status,
  amount: "40000000",
  payee: "bob.earmark.testnet",
  spender: "maya.earmark.testnet",
  work: "https://x",
  decidedBy: null,
  expiresMs: Date.UTC(2026, 10, 14, 14, 0),
  daoProposal: null,
  ...over,
});
const ctx: Ctx = {
  app: "https://app",
  budgetId: "0",
  budgetName: "News <contributors>",
  meta: { symbol: "USDC", decimals: 6 },
  approvers: ["priya.earmark.testnet", "maya.earmark.testnet"],
  mentions: new Map([["priya.earmark.testnet", 42]]),
  trezu: (p) => `https://trezu/${p}`,
};

describe("diff", () => {
  it("records a new subscription's first look without messages", () => {
    const { changes, next } = diff(null, [req("pending_approval")]);
    expect(changes).toEqual([]);
    expect(next).toEqual({ "request:r1": "pending_approval" });
  });
  it("finds a new item and a status change, and ignores the unchanged", () => {
    const items: Item[] = [req("paid"), req("pending_approval", { id: "r2" })];
    const { changes } = diff(
      { "request:r1": "pending_approval", "request:r2": "pending_approval" },
      [...items, req("paid", { id: "r3" })],
    );
    expect(changes.map((c) => [c.item.id, c.from])).toEqual([
      ["r1", "pending_approval"],
      ["r3", null],
    ]);
  });
});

describe("message", () => {
  it("asks the other approvers, @mentions the linked one, escapes chain text", () => {
    const out = message({ item: req("pending_approval"), from: null }, ctx, false);
    expect(out?.kind).toBe("send");
    expect(out?.msg.text).toContain("40 USDC");
    expect(out?.msg.text).toContain('<a href="tg://user?id=42">Priya</a>');
    // The spender can't approve their own payment, so isn't asked.
    expect(out?.msg.text).not.toMatch(/approver:.*Maya/);
    expect(out?.msg.text).toContain("News &lt;contributors&gt;");
    expect(out?.msg.dm).toEqual(["priya.earmark.testnet"]);
  });
  it("edits the thread when paid, and posts Paid when the payment was instant", () => {
    expect(message({ item: req("paid"), from: "pending_approval" }, ctx, true)?.kind).toBe("edit");
    const instant = message({ item: req("paid"), from: null }, ctx, false);
    expect(instant?.kind).toBe("send");
    expect(instant?.msg.text).toMatch(/^✅ Paid 40 USDC/);
  });
  it("says a queued change can be applied after its time, not that it applies itself", () => {
    const out = message(
      {
        item: {
          kind: "change",
          id: "7",
          status: "queued",
          text: "Maya pays instantly up to 200 USDC",
          by: "maya.earmark.testnet",
          effectiveMs: Date.UTC(2026, 10, 14, 14, 5),
        },
        from: null,
      },
      ctx,
      false,
    );
    expect(out?.msg.text).toContain("Can be applied after Sat 14 Nov, 14:05 UTC");
  });
});

describe("reminder", () => {
  it("fires once, inside the last 6 hours", () => {
    const r = req("pending_approval");
    expect(needsReminder(r, r.expiresMs - 7 * 3600_000, false)).toBe(false);
    expect(needsReminder(r, r.expiresMs - 3600_000, false)).toBe(true);
    expect(needsReminder(r, r.expiresMs - 3600_000, true)).toBe(false);
  });
  it("escapes HTML", () => expect(esc("a<b>&")).toBe("a&lt;b&gt;&amp;"));
});
