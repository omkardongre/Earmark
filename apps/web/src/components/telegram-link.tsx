"use client";

import { useEffect, useState } from "react";
import { Button, Card, Pill, TextButton } from "./ui";
import { useWallet } from "./wallet";

type Target =
  | { kind: "group"; budgetId: string }
  | { kind: "me"; account: string }
  | { kind: "watch"; requestId: string }
  | { kind: "watch"; taskId: string };

/**
 * Gets a one-time Telegram link and opens it. The tab is opened on click (before the request),
 * so the browser doesn't block it as a popup.
 */
function useOpen() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = async (target: Target) => {
    setError(null);
    setBusy(true);
    const tab = window.open("", "_blank");
    try {
      const res = await fetch("/api/alerts/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(target),
      });
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !body.url) throw new Error(body.error ?? "Couldn’t make a link.");
      if (tab) tab.location.href = body.url;
      else window.location.href = body.url;
    } catch (e) {
      tab?.close();
      setError(e instanceof Error ? e.message : "Couldn’t make a link.");
    } finally {
      setBusy(false);
    }
  };
  return { open, busy, error };
}

/**
 * Budget page, for leads and approvers: one reason to connect, one main action, and whether a
 * team chat is already connected. "Just me" links the signed-in account for DMs and mentions.
 */
export function TelegramAlerts({ budgetId }: { budgetId: string }) {
  const { accountId } = useWallet();
  const { open, busy, error } = useOpen();
  const [chats, setChats] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/alerts/status?budgetId=${encodeURIComponent(budgetId)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { chats?: number } | null) => live && setChats(b?.chats ?? 0))
      .catch(() => live && setChats(0));
    return () => {
      live = false;
    };
  }, [budgetId]);
  const on = (chats ?? 0) > 0;
  return (
    <Card className="space-y-3 p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">Telegram alerts</h2>
        {on && <Pill tone="green">On</Pill>}
      </div>
      <p className="text-muted">
        {on
          ? `Posting to ${chats === 1 ? "your team chat" : `${chats} team chats`}. Send /stop there to turn it off.`
          : "Get pinged when a payment needs approval."}
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button
          variant="secondary"
          className={on ? "" : "w-full"}
          busy={busy}
          onClick={() => open({ kind: "group", budgetId })}
        >
          {on ? "Add another chat" : "Connect team chat"}
        </Button>
        {accountId && (
          <TextButton disabled={busy} onClick={() => open({ kind: "me", account: accountId })}>
            Just me instead
          </TextButton>
        )}
      </div>
      {error && (
        <p className="text-sm text-rose-700" role="alert">
          {error}
        </p>
      )}
    </Card>
  );
}

/** Payment or task page: one message in Telegram when it finishes. */
export function TelegramWatch(props: { requestId: string } | { taskId: string }) {
  const { open, busy, error } = useOpen();
  return (
    <span className="inline-flex flex-col gap-1">
      <TextButton disabled={busy} onClick={() => open({ kind: "watch", ...props } as Target)}>
        {"requestId" in props ? "Tell me on Telegram when it’s paid" : "Follow on Telegram"}
      </TextButton>
      {error && (
        <span className="text-sm text-rose-700" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
