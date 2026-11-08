"use client";

import { useEffect, useRef, useState } from "react";
import { units } from "@/lib/format";
import type { TokenMeta } from "@/lib/types";

const MS = 700;
const easeOut = (t: number) => 1 - (1 - t) ** 3;

/**
 * A token amount that counts to its new value when it changes (after a payment the server data
 * refreshes and the prop changes). The first render and the last frame are the exact `units()`
 * text; frames in between are close approximations. No motion with prefers-reduced-motion.
 */
export function AnimatedNumber({ value, meta }: { value: string; meta: TokenMeta }) {
  const [shown, setShown] = useState(() => units(value, meta));
  const from = useRef(value);

  useEffect(() => {
    const prev = from.current;
    from.current = value;
    const exact = units(value, meta);
    if (prev === value) return setShown(exact);
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches || document.hidden;
    if (still) return setShown(exact);
    const scale = 10 ** meta.decimals;
    const a = Number(BigInt(prev)) / scale;
    const b = Number(BigInt(value)) / scale;
    // As many decimals as the final text, so the width barely moves.
    const digits = exact.split(".")[1]?.length ?? 0;
    const fmt = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / MS);
      if (t < 1) {
        setShown(fmt.format(a + (b - a) * easeOut(t)));
        raf = requestAnimationFrame(step);
      } else setShown(exact);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, meta]);

  // Screen readers get the final value once, not every frame.
  return (
    <span className="tabular">
      <span aria-hidden>{shown}</span>
      <span className="sr-only">{units(value, meta)}</span>
    </span>
  );
}
