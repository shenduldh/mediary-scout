import { NextResponse, type NextRequest } from "next/server";
import { Pan115QrLoginClient } from "@media-track/workflow";

// One long-poll round per request: the upstream endpoint holds the
// connection until the status changes or ~30s passes; the browser just
// re-calls this route until a terminal status arrives.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const uid = request.nextUrl.searchParams.get("uid") ?? "";
  const time = Number(request.nextUrl.searchParams.get("time") ?? "0");
  const sign = request.nextUrl.searchParams.get("sign") ?? "";
  if (!uid || !sign || !Number.isFinite(time)) {
    return NextResponse.json({ ok: false, error: "missing session params" }, { status: 400 });
  }
  try {
    const status = await new Pan115QrLoginClient().pollStatus({
      uid,
      time,
      sign,
      qrcodeContent: "",
    });
    return NextResponse.json({ ok: true, status });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 502 });
  }
}
