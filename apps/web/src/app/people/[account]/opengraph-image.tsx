// The preview image a shared record link shows (X, Telegram, Slack): who, and their paid work.
import { ImageResponse } from "next/og";
import { loadBase } from "@/lib/data";
import { money, shortName } from "@/lib/format";
import { getPayeeRecord, getRecord } from "@/lib/near";

export const alt = "A contributor's paid work on Earmark";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image({ params }: { params: Promise<{ account: string }> }) {
  const account = decodeURIComponent((await params).account);
  const valid = /^[a-z0-9._-]{2,64}$/.test(account);
  const [base, paid, led] = valid
    ? await Promise.all([loadBase(), getPayeeRecord(account), getRecord(account)]).catch(
        () => [null, null, null] as const,
      )
    : ([null, null, null] as const);
  const meta = base?.meta.values().next().value;
  const lines: string[] = [];
  if (paid && paid.paid_count > 0)
    lines.push(
      `Paid ${paid.paid_count} ${paid.paid_count === 1 ? "time" : "times"} for reviewed work${meta ? ` · ${money(paid.paid_total, meta)}` : ""}`,
    );
  if (led && led.paid_count > 0)
    lines.push(
      `Paid ${led.paid_count} ${led.paid_count === 1 ? "contributor" : "contributors"} from a team budget${led.rejected_for_cause === 0 ? " · no rejections" : ""}`,
    );
  if (lines.length === 0) lines.push("No paid work yet");
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 72,
        background: "#f6f7fb",
        color: "#0f172a",
        fontFamily: "sans-serif",
      }}
    >
      <div
        style={{ display: "flex", alignItems: "center", gap: 18, fontSize: 36, fontWeight: 700 }}
      >
        <div
          style={{
            display: "flex",
            width: 60,
            height: 60,
            borderRadius: 16,
            background: "#4f46e5",
            color: "white",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          E
        </div>
        Earmark
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div style={{ fontSize: 84, fontWeight: 700 }}>
          {valid ? shortName(account) : "Earmark"}
        </div>
        {lines.map((l) => (
          <div key={l} style={{ fontSize: 40, color: "#475569" }}>
            {l}
          </div>
        ))}
      </div>
      <div style={{ fontSize: 28, color: "#64748b" }}>
        Every payment is on NEAR, under rules the DAO voted for.
      </div>
    </div>,
    size,
  );
}
