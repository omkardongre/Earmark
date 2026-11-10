"use client";

import { useState } from "react";
import { useToast } from "./toast";
import { Button } from "./ui";
import { useWallet } from "./wallet";

const RESULT: Record<string, string> = {
  paid_by_dao: "Paid.",
  escalation_closed: "The DAO vote closed without paying.",
  escalated: "The vote is still open.",
  dao_funded: "Not paid yet. The money is still held; try again later.",
};

/**
 * R18, R22: anyone can call `settle_escalation`. On an open vote it records the DAO's decision;
 * once the DAO's money is held (`payout`), it pays the payee. The contract reads the proposal
 * itself and only ever pays the listed payee, so the caller can't change the outcome.
 */
export function SettleButton({
  requestId,
  payout,
}: {
  requestId: string;
  payout?: "first" | "retry";
}) {
  const { accountId, call } = useWallet();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!accountId) return null;

  return (
    <Button
      variant="secondary"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const r = await call("settle_escalation", { request_id: requestId }, { gasTgas: 80 });
        setBusy(false);
        toast(
          r.ok
            ? { ok: true, text: RESULT[String(r.value)] ?? "Checked the DAO vote.", tx: r.hash }
            : { ok: false, text: r.error },
        );
      }}
    >
      {busy
        ? "Confirm in wallet…"
        : payout === "retry"
          ? "Try the payout again"
          : payout
            ? "Pay it out"
            : "Check the DAO result"}
    </Button>
  );
}
