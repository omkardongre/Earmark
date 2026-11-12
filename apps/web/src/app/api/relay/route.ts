import { NextResponse } from "next/server";
import { REFUSAL_TEXT, relay, relayEnabled } from "@/lib/relay";

export const dynamic = "force-dynamic";

/** GET: whether this server covers fees (the app shows "Network fee paid by Earmark"). */
export function GET() {
  return NextResponse.json({ enabled: relayEnabled() });
}

/** POST { signedDelegate: base64 }: relays one member-signed call to our contract (docs/05 §4). */
export async function POST(req: Request) {
  let body: { signedDelegate?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: REFUSAL_TEXT.bad_payload, reason: "bad_payload" },
      {
        status: 400,
      },
    );
  }
  try {
    const r = await relay(body.signedDelegate);
    if (!r.ok) {
      return NextResponse.json(
        { error: REFUSAL_TEXT[r.reason], reason: r.reason },
        {
          status: r.status,
        },
      );
    }
    return NextResponse.json({ outcome: r.outcome });
  } catch {
    // The network didn't answer. The signed call may or may not have landed; the app reloads
    // and the contract refuses a repeat (same request id, same work link, one-way steps).
    return NextResponse.json(
      { error: "The network didn't answer. Check the page before trying again.", reason: "rpc" },
      { status: 502 },
    );
  }
}
