import { billingReturn } from "./billing-continuation";
import type { CurrentUser } from "./auth-types";

// Preserve only actual platform routes; never accept origins, queries or fragments.
export function platformReturn(value: string | null): string | null {
  return value && /^\/super-admin(?:\/settings|\/admins|\/organizations\/[a-zA-Z0-9_-]{1,100})?$/.test(value) ? value : null;
}
export function platformLoginHref(destination: string) {
  return `/super-admin/login?${new URLSearchParams({ next: platformReturn(destination) || "/super-admin", reason: "session-ended" })}`;
}
export function loginDestination(role: CurrentUser["role"] | undefined, next: string | null) {
  // Legacy User roles never resolve a platform identity or authorize platform pages.
  void role;
  // A platform continuation does not grant a tenant account platform privileges.
  return billingReturn(next) || "/dashboard";
}
