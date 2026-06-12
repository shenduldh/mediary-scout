import { type NextRequest } from "next/server";

// Proxy the official QR PNG so the page needs no QR-rendering dependency.
export async function GET(request: NextRequest): Promise<Response> {
  const uid = request.nextUrl.searchParams.get("uid") ?? "";
  if (!uid) {
    return new Response("missing uid", { status: 400 });
  }
  const upstream = await fetch(
    `https://qrcodeapi.115.com/api/1.0/web/1.0/qrcode?uid=${encodeURIComponent(uid)}`,
    { headers: { Referer: "https://115.com/" } },
  );
  if (!upstream.ok) {
    return new Response("upstream error", { status: 502 });
  }
  return new Response(upstream.body, {
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "image/png",
      "Cache-Control": "no-store",
    },
  });
}
