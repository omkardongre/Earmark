import { staleSince } from "@/lib/near";
import { LocalTime } from "./local-time";

/**
 * "Live data is loading, showing values from <time>" when chain reads fell back to the last good
 * values. Server component. Without `since` it reads the read layer's state, so render it after
 * the page's (or layout's) reads have run; it renders nothing while reads are live.
 */
export function StaleNotice({ since }: { since?: number | null }) {
  const at = since === undefined ? staleSince() : since;
  if (at === null) return null;
  return (
    <p
      role="status"
      className="rounded-xl bg-amber-50 px-4 py-2.5 text-sm text-amber-900 ring-1 ring-inset ring-amber-600/20"
    >
      Live data is loading, showing values from <LocalTime ns={String(BigInt(at) * 1_000_000n)} />.
    </p>
  );
}
