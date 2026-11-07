"use client";

import { useEffect, useState } from "react";
import { txUrl } from "@/lib/config";
import { ago, shortName } from "@/lib/format";
import type { EarmarkEvent } from "@/lib/near";
import { ExternalLink } from "./ui";

/** Tries while the history indexer catches up with a payment made seconds ago (about 15 s). */
const TRIES = 5;
const EVERY_MS = 3000;

/** Each step of a payment with its transaction. Fills in by itself when the history lags. */
export function PaymentSteps({
  id,
  payee,
  first,
}: {
  id: string;
  payee: string;
  first: EarmarkEvent[] | null;
}) {
  const [events, setEvents] = useState(first);
  const [tries, setTries] = useState(0);
  const waiting = (events === null || events.length === 0) && tries < TRIES;

  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/steps/${encodeURIComponent(id)}`, { cache: "no-store" });
        if (res.ok) setEvents((await res.json()) as EarmarkEvent[]);
      } catch {
        // Try again on the next tick.
      }
      setTries((n) => n + 1);
    }, EVERY_MS);
    return () => clearTimeout(t);
  }, [waiting, id]);

  if (events && events.length > 0) {
    return (
      <ol className="space-y-4">
        {events.map((e) => (
          <li key={`${e.tx}-${e.event}`} className="flex gap-3">
            <span className="mt-1.5 size-2.5 shrink-0 rounded-full bg-brand" aria-hidden />
            <div className="min-w-0 flex-1">
              <p>{step(e, payee)}</p>
              <p className="text-sm text-muted">
                {ago(e.timestampNs)} · <ExternalLink href={txUrl(e.tx)}>Transaction</ExternalLink>
              </p>
            </div>
          </li>
        ))}
      </ol>
    );
  }
  return (
    <p className="text-muted" aria-live="polite">
      {waiting
        ? "Loading the steps. A payment made just now takes a few seconds to show here…"
        : "The steps can’t be loaded right now. Reload the page in a minute."}
    </p>
  );
}

function step(e: EarmarkEvent, payee: string): string {
  const str = (k: string) => (typeof e.data[k] === "string" ? (e.data[k] as string) : "");
  switch (e.event) {
    case "spend_requested":
      return `${shortName(str("spender"))} asked to pay`;
    case "spend_escalated":
      return e.data.dao_proposal_id
        ? `Sent to a DAO vote (proposal #${String(e.data.dao_proposal_id)})`
        : "Sending to a DAO vote";
    case "spend_approved":
      return `${shortName(str("approver"))} approved`;
    case "spend_rejected":
      return `${shortName(str("approver"))} rejected: ${str("reason")}`;
    case "spend_paid":
      return `Paid to ${shortName(payee)}`;
    case "spend_failed":
      return `Didn’t go through (${str("reason").replaceAll("_", " ")}); nothing was spent`;
    case "spend_expired":
      return "Expired without a decision";
    case "escalation_settled":
      return str("outcome") === "approved"
        ? `DAO approved and paid ${shortName(payee)}`
        : `DAO vote closed (${str("outcome")}); not paid`;
    case "duplicate_overridden":
      return `${shortName(str("approver"))} allowed paying the same work again: ${str("reason")}`;
    default:
      return e.event.replaceAll("_", " ");
  }
}
