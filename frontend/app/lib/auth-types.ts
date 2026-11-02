export type CurrentUser = {
  id: string;
  fullName: string;
  email: string;
  role: "ORGANIZATION_ADMIN" | "EMPLOYEE" | "SUPER_ADMIN";
  emailVerifiedAt: string | null;
  organizationId: string;
  organization: {
    id: string;
    name: string;
    trialStartedAt: string | null;
    trialExpiresAt: string | null;
  };
};
export type AuthResult = {
  success: boolean;
  user?: CurrentUser;
  message?: string;
  errors?: Record<string, string[]>;
  verificationRequired?: boolean;
  email?: string;
  resendAfter?: number;
  verificationEmail?: { status: string; code?: string; message?: string };
};
export const SESSION_COOKIE = "hrms_session";
export const PLATFORM_COOKIE = "hrms_platform_session";
export type PlatformAdmin = { id: string; fullName: string; email: string; emailVerifiedAt: string | null };
export const VERIFICATION_COOKIE = "hrms_verification";
export const VERIFICATION_DELIVERY = "hrms.verification.delivery";
