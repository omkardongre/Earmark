// approver -> payments waiting for them: the nav badge reloads it after an action. Public data.
import { NextResponse } from "next/server";
import { approverQueue } from "@/lib/data";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await approverQueue(), { headers: { "Cache-Control": "no-store" } });
}
