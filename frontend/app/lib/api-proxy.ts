import { NextRequest, NextResponse } from "next/server";
import { apiBaseUrl } from "./auth-server";
import { SESSION_COOKIE, VERIFICATION_COOKIE, PLATFORM_COOKIE } from "./auth-types";

// A same-origin bridge keeps the host-only session cookie on the frontend host,
// including deployments where the API lives on a different origin.
export async function proxyApi(request: NextRequest, path: string) {
  const mutation = request.method === "POST";
  const origin = process.env.APP_ORIGIN || request.nextUrl.origin;
  if (
    mutation &&
    (request.headers.get("origin") !== origin ||
      request.headers.get("x-hrms-request") !== "1" ||
      request.headers.get("content-type")?.split(";")[0].trim() !==
        "application/json")
  )
    return NextResponse.json(
      {
        success: false,
        message: "Request origin or CSRF protection could not be verified.",
      },
      { status: 403 },
    );
  const declaredLength = Number(request.headers.get("content-length"));
  if (declaredLength > 16384)
    return NextResponse.json(
      { success: false, message: "Request is too large." },
      { status: 413 },
    );
  try {
    // Limit streamed bodies too; Content-Length alone is not authoritative.
    let body: string | undefined;
    if (mutation) {
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 16384) {
            await reader.cancel();
            return NextResponse.json(
              { success: false, message: "Request is too large." },
              { status: 413 },
            );
          }
          chunks.push(value);
        }
      }
      body = Buffer.concat(chunks).toString("utf8");
    }
    const cookieNames = path.startsWith("super-admin/") ? [PLATFORM_COOKIE] : [SESSION_COOKIE, VERIFICATION_COOKIE, ...(path.startsWith("auth/register") ? ["hrms_registration"] : [])];
    // A stale or invalid server module is an availability failure, not an expired login.
    if (cookieNames.some((name) => typeof name !== "string" || !name)) throw new Error("Session cookie configuration unavailable.");
    const cookieHeader = cookieNames.flatMap((name) => {
      const token = request.cookies.get(name)?.value;
      return token && /^[a-f0-9]{64}$/.test(token) ? [`${name}=${token}`] : [];
    }).join("; ");
    const response = await fetch(`${apiBaseUrl()}/api/${path}`, {
      method: request.method,
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "X-HRMS-Request": "1",
        ...(cookieHeader
          ? { Cookie: cookieHeader }
          : {}),
      },
      body,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    const result = new NextResponse(await response.text(), {
      status: response.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store, private",
      },
    });
    for (const cookie of response.headers.getSetCookie())
      result.headers.append("Set-Cookie", cookie);
    for (const header of ["retry-after", "ratelimit", "ratelimit-policy"]) {
      const value = response.headers.get(header);
      if (value) result.headers.set(header, value);
    }
    return result;
  } catch {
    return NextResponse.json(
      {
        success: false,
        message: "The service is temporarily unavailable. Please try again.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
