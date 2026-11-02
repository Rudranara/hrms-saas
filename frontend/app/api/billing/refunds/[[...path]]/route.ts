import { NextRequest, NextResponse } from "next/server";
import { proxyApi } from "../../../../lib/api-proxy";
async function forward(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  const path = (await context.params).path?.join("/") || "";
  if ((request.method === "GET" && path) || (request.method === "POST" && path && !/^[a-zA-Z0-9_-]{1,100}\/refresh$/.test(path))) return NextResponse.json({ message: "Endpoint not found." }, { status: 404 });
  if (request.method === "POST" && request.nextUrl.search) return NextResponse.json({ message: "Unexpected query parameters." }, { status: 400 });
  return proxyApi(request, `billing/refunds${path ? `/${path}` : ""}${request.nextUrl.search}`);
}
export const GET = forward;
export const POST = forward;
