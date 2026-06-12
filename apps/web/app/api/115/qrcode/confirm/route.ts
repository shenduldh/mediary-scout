import { NextResponse, type NextRequest } from "next/server";
import { completePan115QrLogin } from "../../../../../lib/workflow-runtime";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as {
      session?: { uid?: string; time?: number; sign?: string };
      app?: string;
    };
    const { uid, time, sign } = body.session ?? {};
    if (!uid || !sign || typeof time !== "number") {
      return NextResponse.json({ ok: false, error: "missing session params" }, { status: 400 });
    }
    const result = await completePan115QrLogin({
      session: { uid, time, sign, qrcodeContent: "" },
      ...(body.app === undefined ? {} : { app: body.app }),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 502 });
  }
}
