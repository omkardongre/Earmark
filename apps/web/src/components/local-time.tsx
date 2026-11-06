"use client";

import { useEffect, useState } from "react";

const fmt = (ms: number, timeZone?: string) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    ...(timeZone ? { timeZone, timeZoneName: "short" } : {}),
  }).format(ms);

/**
 * An exact date and time ("5 Nov 2026, 12:41"), like a receipt, in the reader's own time zone.
 * The server doesn't know that zone, so it renders UTC first and the browser swaps in local time.
 */
export function LocalTime({ ns }: { ns: string }) {
  const ms = Number(BigInt(ns) / 1_000_000n);
  const [text, setText] = useState(() => fmt(ms, "UTC"));
  useEffect(() => setText(fmt(ms)), [ms]);
  return <time dateTime={new Date(ms).toISOString()}>{text}</time>;
}
