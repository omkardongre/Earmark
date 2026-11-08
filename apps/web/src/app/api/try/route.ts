import { NextResponse } from "next/server";
import { allow, runScene, SCENES, type Scene, tryEnabled } from "@/lib/try";

export const dynamic = "force-dynamic";

/** POST { scene, requestId? }: runs one "Try it" step on the testnet sandbox. */
export async function POST(req: Request) {
  if (!tryEnabled()) {
    return NextResponse.json({ error: "Try it isn't set up on this server." }, { status: 503 });
  }
  let body: { scene?: unknown; requestId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const scene = body.scene as Scene;
  if (!SCENES.includes(scene)) return NextResponse.json({ error: "bad scene" }, { status: 400 });
  // Cloud Run's front end appends the caller's address last; anything before it is client-sent.
  const visitor = req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || "local";
  if (!allow(visitor, scene === "race" ? 2 : 1)) {
    return NextResponse.json(
      { error: "Too many tries for now. Wait a few minutes and try again." },
      { status: 429, headers: { "Retry-After": "600" } },
    );
  }
  const requestId = body.requestId;
  if (
    scene === "approve" &&
    (typeof requestId !== "string" || !/^try-[a-f0-9-]{12}$/.test(requestId))
  ) {
    return NextResponse.json({ error: "bad request id" }, { status: 400 });
  }
  try {
    return NextResponse.json(await runScene(scene, requestId as string | undefined));
  } catch {
    return NextResponse.json(
      { error: "The testnet didn't answer. Try again in a moment." },
      { status: 502 },
    );
  }
}
