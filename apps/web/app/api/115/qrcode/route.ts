import { NextResponse } from "next/server";
import { Pan115QrLoginClient } from "@media-track/workflow";

export async function POST(): Promise<NextResponse> {
  try {
    const session = await new Pan115QrLoginClient().getToken();
    return NextResponse.json({ ok: true, session });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 502 });
  }
}
