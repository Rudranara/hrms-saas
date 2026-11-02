import "server-only";
import { cookies } from "next/headers";
import { connection } from "next/server";
import type { CurrentUser } from "./auth-types";
import { SESSION_COOKIE, VERIFICATION_COOKIE, PLATFORM_COOKIE, type PlatformAdmin } from "./auth-types";
import type { BillingAccess, CheckoutReadiness } from "./billing-types";

export function apiBaseUrl() {
  const value = process.env.NEXT_PUBLIC_API_URL;
  if (!value) throw new Error("The API connection is not configured.");
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Invalid API configuration.");
  return value.replace(/\/$/, "");
}
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const response = await fetch(`${apiBaseUrl()}/api/auth/me`, {
    headers: { Cookie: `${SESSION_COOKIE}=${token}` },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  if (response.status === 401) return null;
  if (!response.ok)
    throw new Error(
      "Your workspace is temporarily unavailable. Please try again.",
    );
  const data: { success: boolean; user?: CurrentUser } = await response.json();
  if (!data.success || !data.user)
    throw new Error("Unable to verify your session.");
  return data.user;
}
export async function getPlatformAdmin(): Promise<PlatformAdmin | null> {
  // Authentication and its timeout must run for a real request, never a prerender.
  await connection();
  const token = (await cookies()).get(PLATFORM_COOKIE)?.value;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const response = await fetch(`${apiBaseUrl()}/api/super-admin/auth/me`, {
    headers: { Cookie: `${PLATFORM_COOKIE}=${token}` }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8000),
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("Platform session verification is temporarily unavailable.");
  const result = await response.json();
  if (!result.success || !result.admin) throw new Error("Unable to verify platform session.");
  return result.admin;
}
export async function getVerificationStatus(): Promise<{ email: string; verified: boolean; deliveryAvailable: boolean; deliveryConfigurationError?: { code: string; message: string } | null } | null> {
  const jar = await cookies();
  const cookieHeader = [VERIFICATION_COOKIE, SESSION_COOKIE].flatMap((name) => {
    const token = jar.get(name)?.value;
    return token && /^[a-f0-9]{64}$/.test(token) ? [`${name}=${token}`] : [];
  }).join("; ");
  if (!cookieHeader) return null;
  const response = await fetch(`${apiBaseUrl()}/api/auth/verification-status`, {
    headers: { Cookie: cookieHeader }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8000),
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("Verification status is temporarily unavailable. Please retry.");
  return response.json();
}
export async function getBillingStatus(): Promise<{
  access: BillingAccess;
  providerAvailable: boolean;
  mode: "test" | "live";
  checkoutReadiness: CheckoutReadiness;
}> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || !/^[a-f0-9]{64}$/.test(token))
    throw new Error("Please sign in.");
  const response = await fetch(`${apiBaseUrl()}/api/billing/status`, {
    headers: { Cookie: `${SESSION_COOKIE}=${token}` },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok)
    throw new Error("Subscription status is temporarily unavailable.");
  return response.json();
}
