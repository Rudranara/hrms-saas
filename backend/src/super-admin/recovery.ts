import { randomInt } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { hashPassword } from "../auth/password";
import { hashToken } from "../auth/security";
import type { Mailer } from "../services/mail";
import { ServiceError, type Clock } from "../services/errors";

const RESET_TTL_MS = 30 * 60000;
const successMessage = "Your reset code was accepted for delivery. Check your inbox and spam folder.";

function invalidReset(code = "TOKEN_INVALID"): never {
  throw new ServiceError(code, code === "TOKEN_USED" ? 409 : 400,
    code === "TOKEN_EXPIRED" ? "This code has expired. Request a new reset code."
      : code === "TOKEN_USED" ? "This code has already been used. Request a new reset code or sign in."
        : "This code is invalid. Request a new reset code.");
}

export class SuperAdminRecoveryService {
  constructor(private db: PrismaClient, private mailer: Mailer, private origin: string, private clock: Clock) {}

  private audit(db: PrismaClient | Prisma.TransactionClient, actorSuperAdminId: string, action: string, outcome: "SUCCESS" | "FAILED", reasonCode?: string) {
    return db.superAdminAuditEvent.create({ data: { actorSuperAdminId, action, outcome, reasonCode, createdAt: this.clock() } });
  }

  async request(email: string, resend = false) {
    const started = Date.now();
    let resendAvailableAt: Date | undefined;
    try {
      const admin = await this.db.superAdmin.findUnique({ where: { email }, select: { id: true, email: true, authVersion: true, isActive: true, emailVerifiedAt: true } });
      if (!admin?.isActive)
        throw new ServiceError("PLATFORM_ACCOUNT_NOT_FOUND", 404, "No active platform administrator account uses that email address.");
      if (!this.mailer.available)
        throw new ServiceError("EMAIL_UNAVAILABLE", 503, "Password recovery email is temporarily unavailable. Please try later.");
      {
        const token = String(randomInt(10_000_000, 100_000_000));
        const tokenHash = hashToken(token), now = this.clock();
        try {
          await this.db.$transaction(async (tx) => {
            const locked = await tx.superAdmin.updateMany({ where: { id: admin.id, email: admin.email, isActive: true, authVersion: admin.authVersion }, data: { updatedAt: now } });
            if (locked.count !== 1) throw new ServiceError("ACCOUNT_CHANGED", 409, "Your account changed. Please request a new reset code.");
            const previous = await tx.superAdminPasswordReset.findUnique({ where: { superAdminId: admin.id } });
            // The email-entry form starts a fresh request immediately; only the
            // dedicated Resend OTP action uses the one-minute cooldown.
            if (resend && previous && !previous.consumedAt && now.getTime() - previous.createdAt.getTime() < 60000)
              throw new ServiceError("RATE_LIMITED", 429, "Please wait a minute before requesting another reset code.");
            await tx.superAdminPasswordReset.upsert({ where: { superAdminId: admin.id }, create: { superAdminId: admin.id, tokenHash, authVersion: admin.authVersion, createdAt: now, expiresAt: new Date(now.getTime() + RESET_TTL_MS), consumedAt: null }, update: { tokenHash, authVersion: admin.authVersion, createdAt: now, expiresAt: new Date(now.getTime() + RESET_TTL_MS), consumedAt: null } });
            await this.audit(tx, admin.id, "PASSWORD_RESET_REQUESTED", "SUCCESS");
          }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
          await this.mailer.send({ to: admin.email, subject: "Your HRMS Platform password reset code", text: `Your HRMS Platform password reset code is: ${token}\n\nEnter this eight-digit code at ${this.origin}/super-admin/forgot-password. It expires in 30 minutes and can be used only once. Resetting your password signs out all platform sessions. If you did not request this, you can ignore this email.` });
          resendAvailableAt = new Date(now.getTime() + 60000);
        } catch (error) {
          if (error instanceof ServiceError && ["RATE_LIMITED", "ACCOUNT_CHANGED"].includes(error.code)) throw error;
          // Do not show a code-entry screen when SMTP did not accept the mail.
          // Invalidate the issued code so a delayed or retried delivery cannot be used.
          await this.db.superAdminPasswordReset.updateMany({ where: { superAdminId: admin.id, tokenHash, consumedAt: null }, data: { consumedAt: this.clock() } });
          await this.audit(this.db, admin.id, "PASSWORD_RESET_REQUESTED", "FAILED", "DELIVERY_FAILED");
          throw error;
        }
      }
    } finally {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 350 - (Date.now() - started))));
    }
    return { message: successMessage, resendAvailableAt };
  }

  async verify(email: string, code: string) {
    const admin = await this.db.superAdmin.findUnique({ where: { email }, select: { id: true, authVersion: true, isActive: true, emailVerifiedAt: true } });
    if (!admin?.isActive) invalidReset();
    const reset = await this.db.superAdminPasswordReset.findUnique({ where: { superAdminId: admin.id } });
    if (!reset || reset.tokenHash !== hashToken(code) || reset.authVersion !== admin.authVersion) invalidReset();
    if (reset.consumedAt) invalidReset("TOKEN_USED");
    if (reset.expiresAt <= this.clock()) invalidReset("TOKEN_EXPIRED");
    return { valid: true };
  }

  async consume(email: string, code: string, password: string) {
    await this.verify(email, code);
    const known = await this.db.superAdmin.findUniqueOrThrow({ where: { email }, select: { id: true, authVersion: true } });
    const passwordHash = await hashPassword(password);
    await this.db.$transaction(async (tx) => {
      const now = this.clock();
      // Lock the account before its token, matching login and account changes.
      const locked = await tx.superAdmin.updateMany({ where: { id: known.id, email, isActive: true, authVersion: known.authVersion }, data: { updatedAt: now } });
      if (locked.count !== 1) invalidReset();
      const admin = await tx.superAdmin.findUniqueOrThrow({ where: { email }, select: { id: true, authVersion: true, isActive: true, emailVerifiedAt: true } });
      const reset = await tx.superAdminPasswordReset.findUnique({ where: { superAdminId: admin.id } });
      if (!admin.isActive || !reset || reset.tokenHash !== hashToken(code) || reset.authVersion !== admin.authVersion || reset.consumedAt || reset.expiresAt <= now) invalidReset(reset?.consumedAt ? "TOKEN_USED" : "TOKEN_INVALID");
      const consumed = await tx.superAdminPasswordReset.updateMany({ where: { id: reset.id, tokenHash: hashToken(code), consumedAt: null, expiresAt: { gt: now }, authVersion: admin.authVersion }, data: { consumedAt: now } });
      if (consumed.count !== 1) invalidReset("TOKEN_USED");
      await tx.superAdmin.update({ where: { id: admin.id }, data: { passwordHash, emailVerifiedAt: admin.emailVerifiedAt ?? now, authVersion: { increment: 1 } } });
      await tx.superAdminSession.deleteMany({ where: { superAdminId: admin.id } });
      await tx.superAdminEmailChange.updateMany({ where: { superAdminId: admin.id, state: { in: ["PENDING_DELIVERY", "SENT"] } }, data: { state: "CANCELLED", consumedAt: now } });
      await this.audit(tx, admin.id, "PASSWORD_RESET", "SUCCESS");
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    return { message: "Your platform password has been updated. Please sign in again." };
  }
}
