import { NextRequest, NextResponse } from "next/server";
import { proxyApi } from "../../../lib/api-proxy";
export async function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const path = (await context.params).path.join("/");
  if (!/^(refunds|auth\/me|metrics|revenue|account|admins|organizations(?:\/[a-zA-Z0-9_-]{1,100}(?:\/(subscriptions|payments|access))?)?)$/.test(path))
    return NextResponse.json({ success: false, message: "Endpoint not found." }, { status: 404 });
  return proxyApi(request, `super-admin/${path}${request.nextUrl.search}`);
}
export async function POST(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const path = (await context.params).path.join("/");
  if (!/^(refunds\/[a-zA-Z0-9_-]{1,100}\/(decision|refresh|process|prepared)|admins|organizations\/[a-zA-Z0-9_-]{1,100}\/access|auth\/(login|logout|forgot-password|reset\/verify-otp|reset-password)|account\/(email(?:\/(confirm|resend))?|password))$/.test(path))
    return NextResponse.json({ success: false, message: "Endpoint not found." }, { status: 404 });
  if (request.nextUrl.search)
    return NextResponse.json({ success: false, message: "Unexpected query parameters." }, { status: 400 });
  return proxyApi(request, `super-admin/${path}`);
}
