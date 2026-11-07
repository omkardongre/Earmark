"use client";

import { useState } from "react";
import { useToast } from "./toast";
import { Button } from "./ui";
import { useWallet } from "./wallet";

const RESULT: Record<string, string> = {
  paid_by_dao: "The DAO paid it.",
  escalation_closed: "The DAO vote closed without paying.",
  escalated: "The vote is still open.",
};

/**
 * R18: anyone can record the DAO's decision on an escalated payment. The contract reads the
 * proposal itself, so this only frees the lead's DAO-vote slot; it can't change the outcome.
 */
export function SettleButton({ requestId }: { requestId: string }) {
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
      {busy ? "Confirm in wallet…" : "Check the DAO result"}
    </Button>
  );
}
