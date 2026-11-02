import { NextRequest, NextResponse } from "next/server";
import { proxyApi } from "../../../lib/api-proxy";
async function forward(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const action = (await context.params).path.join("/");
  const allowed =
    request.method === "GET"
      ? ["me", "verification-status"]
      : [
          "register",
          "register/verify",
          "register/resend",
          "login",
          "logout",
          "verification/request",
          "verification/confirm",
          "forgot-password",
          "reset/verify-otp",
          "reset/validate",
          "reset-password",
        ];
  if (!allowed.includes(action))
    return NextResponse.json(
      { success: false, message: "Endpoint not found." },
      { status: 404 },
    );
  return proxyApi(request, `auth/${action}`);
}
export const GET = forward;
export const POST = forward;
