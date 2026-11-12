"use client";

import { useState } from "react";
import { Button, TextButton } from "./ui";
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

/** Budget page: alerts for the team chat, and "Mention me" for the signed-in person. */
export function TelegramAlerts({ budgetId }: { budgetId: string }) {
  const { accountId } = useWallet();
  const { open, busy, error } = useOpen();
  return (
    <div className="space-y-3 px-5 py-4">
      <p className="text-muted">
        Work to review, payments that need an approver, rule changes and “Paid”, in your team chat.
      </p>
      <Button
        variant="secondary"
        className="w-full"
        busy={busy}
        onClick={() => open({ kind: "group", budgetId })}
      >
        Add to a team chat
      </Button>
      {accountId && (
        <TextButton disabled={busy} onClick={() => open({ kind: "me", account: accountId })}>
          Mention me and message me what needs me
        </TextButton>
      )}
      {error && (
        <p className="text-sm text-rose-700" role="alert">
          {error}
        </p>
      )}
      <p className="text-sm text-muted">
        The bot can’t approve or move money. Buttons open Earmark.
      </p>
    </div>
  );
}

/** Payment or task page: one message in Telegram when it finishes. */
export function TelegramWatch(props: { requestId: string } | { taskId: string }) {
  const { open, busy, error } = useOpen();
  return (
    <span className="inline-flex flex-col gap-1">
      <TextButton disabled={busy} onClick={() => open({ kind: "watch", ...props } as Target)}>
        {"requestId" in props ? "Tell me in Telegram when it’s paid" : "Tell me in Telegram"}
      </TextButton>
      {error && (
        <span className="text-sm text-rose-700" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
