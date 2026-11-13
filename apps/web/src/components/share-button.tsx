"use client";
import { useState } from "react";
import { Button } from "./ui";

/** Shares this page: the phone's share sheet where there is one, else copies the link. */
export function ShareButton({ title, text }: { title: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="secondary"
      onClick={async () => {
        const url = window.location.href.split("#")[0] ?? "";
        if (navigator.share) {
          // Closing the sheet rejects; nothing to do then.
          await navigator.share({ title, text, url }).catch(() => {});
          return;
        }
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? "Link copied" : "Share record"}
    </Button>
  );
}
