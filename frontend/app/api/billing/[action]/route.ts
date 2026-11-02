import { NextRequest, NextResponse } from "next/server";
import { proxyApi } from "../../../lib/api-proxy";
async function forward(
  request: NextRequest,
  context: { params: Promise<{ action: string }> },
) {
  const { action } = await context.params;
  const allowed =
    request.method === "GET"
      ? ["plans", "status", "history", "quote", "purchase"]
      : ["checkout", "confirm", "refresh", "cancel", "quote"];
  if (!allowed.includes(action))
    return NextResponse.json(
      { success: false, message: "Endpoint not found." },
      { status: 404 },
    );
  return proxyApi(request, `billing/${action}${request.nextUrl.search}`);
}
export const GET = forward;
export const POST = forward;
