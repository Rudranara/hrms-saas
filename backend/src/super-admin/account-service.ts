import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { Prisma, type PrismaClient, type SuperAdmin } from "@prisma/client";
import { hashPassword, verifyPassword } from "../auth/password";
import { hashToken } from "../auth/security";
import type { Mailer } from "../services/mail";
import { ServiceError, type Clock } from "../services/errors";

export const EMAIL_CHANGE_TTL_MS = 10 * 60000;
const MAX_OTP_ATTEMPTS = 5;
type Action = "EMAIL_CHANGE_REQUESTED" | "EMAIL_CHANGE_SENT" | "EMAIL_CHANGE_FAILED" | "EMAIL_CHANGE_REJECTED" | "EMAIL_CHANGED" | "PASSWORD_CHANGE_REJECTED" | "PASSWORD_CHANGED";
type Snapshot = Pick<SuperAdmin, "id" | "email" | "passwordHash" | "authVersion" | "isActive">;
type Store = PrismaClient | Prisma.TransactionClient;
export class SuperAdminAccountService {
  constructor(private db: PrismaClient, private mailer: Mailer, private origin: string, private clock: Clock) {}
  private audit(db: Store, actorSuperAdminId: string, action: Action, outcome: "SUCCESS" | "FAILED", reasonCode?: string) {
    return db.superAdminAuditEvent.create({ data: { actorSuperAdminId, action, outcome, reasonCode, createdAt: this.clock() } });
  }
  private async authenticate(superAdminId: string, currentPassword: string, action: "EMAIL_CHANGE_REJECTED" | "PASSWORD_CHANGE_REJECTED"): Promise<Snapshot> {
    const user = await this.db.superAdmin.findUnique({ where: { id: superAdminId }, select: { id: true, email: true, passwordHash: true, authVersion: true, isActive: true } });
    if (!user || !user.isActive) throw new ServiceError("FORBIDDEN", 403, "Super Admin access is required.");
    if (!await verifyPassword(currentPassword, user.passwordHash)) {
      await this.audit(this.db, superAdminId, action, "FAILED", "INCORRECT_PASSWORD");
      throw new ServiceError("INCORRECT_PASSWORD", 400, "The current password is incorrect. No account details changed.");
    }
    return user;
  }
  private async lock(tx: Prisma.TransactionClient, user: Snapshot, sessionToken: string) {
    // Same user-first lock order as login, recovery and token consumption.
    const locked = await tx.superAdmin.updateMany({ where: { id: user.id, isActive: true, passwordHash: user.passwordHash, authVersion: user.authVersion, email: user.email }, data: { updatedAt: this.clock() } });
    if (locked.count !== 1) throw new ServiceError("ACCOUNT_CHANGED", 409, "Your account changed. Sign in again before retrying.");
    const session = await tx.superAdminSession.findUnique({ where: { tokenHash: hashToken(sessionToken) } });
    if (!session || session.superAdminId !== user.id || session.authVersion !== user.authVersion || session.expiresAt <= this.clock())
      throw new ServiceError("SESSION_EXPIRED", 401, "Your session ended. Sign in again before changing your account.");
  }
  async settings(superAdminId: string) {
    const [user, pending, auditEvents] = await this.db.$transaction([
      this.db.superAdmin.findUniqueOrThrow({ where: { id: superAdminId }, select: { id: true, fullName: true, email: true, emailVerifiedAt: true, authVersion: true } }),
      this.db.superAdminEmailChange.findUnique({ where: { superAdminId }, select: { newEmail: true, state: true, createdAt: true, expiresAt: true, authVersion: true, otpRequestId: true } }),
      this.db.superAdminAuditEvent.findMany({ where: { actorSuperAdminId: superAdminId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 10, select: { id: true, action: true, outcome: true, reasonCode: true, createdAt: true } }),
    ]);
    return { admin: { id: user.id, fullName: user.fullName, email: user.email, emailVerifiedAt: user.emailVerifiedAt },
      pendingEmailChange: pending && pending.otpRequestId && pending.authVersion === user.authVersion && ["PENDING_DELIVERY", "SENT", "FAILED", "LOCKED"].includes(pending.state)
        ? { newEmail: pending.newEmail, state: pending.state, createdAt: pending.createdAt, expiresAt: pending.expiresAt, expired: pending.expiresAt <= this.clock(), requestId: pending.otpRequestId } : null,
      emailDeliveryAvailable: this.mailer.available, auditEvents };
  }
  async requestEmail(superAdminId: string, sessionToken: string, currentPassword: string, newEmail: string) {
    const user = await this.authenticate(superAdminId, currentPassword, "EMAIL_CHANGE_REJECTED");
    return this.sendEmailCode(user, sessionToken, newEmail);
  }
  async resendEmail(superAdminId: string, sessionToken: string, requestId: string) {
    const user = await this.db.superAdmin.findUnique({ where: { id: superAdminId }, select: { id: true, email: true, passwordHash: true, authVersion: true, isActive: true } });
    if (!user?.isActive) throw new ServiceError("FORBIDDEN", 403, "Super Admin access is required.");
    const previous = await this.db.superAdminEmailChange.findUnique({ where: { superAdminId } });
    if (!previous) throw new ServiceError("EMAIL_CHANGE_INVALID", 400, "Enter your new email and current password to request a verification code.");
    return this.sendEmailCode(user, sessionToken, previous.newEmail, requestId);
  }
  private async sendEmailCode(user: Snapshot, sessionToken: string, newEmail: string, previousRequestId?: string) {
    const superAdminId = user.id;
    if (newEmail === user.email && (await this.db.superAdmin.findUniqueOrThrow({ where: { id: superAdminId } })).emailVerifiedAt) throw new ServiceError("EMAIL_UNCHANGED", 400, "Enter a different email address.");
    if (!this.mailer.available) {
      await this.audit(this.db, superAdminId, "EMAIL_CHANGE_FAILED", "FAILED", "EMAIL_NOT_CONFIGURED");
      throw new ServiceError("EMAIL_NOT_CONFIGURED", 503, "Email delivery is not configured. Your current email and sign-in are unchanged.");
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0"), otpRequestId = randomBytes(32).toString("hex"), now = this.clock();
    const tokenHash = hashToken(`email-change:${otpRequestId}:${code}`);
    const expiresAt = new Date(now.getTime() + EMAIL_CHANGE_TTL_MS);
    await this.db.$transaction(async (tx) => {
      await this.lock(tx, user, sessionToken);
      if (await tx.superAdmin.count({ where: { email: newEmail, id: { not: superAdminId } } })) throw new ServiceError("EMAIL_UNAVAILABLE", 409, "That email address cannot be used. Your current email is unchanged.");
      const previous = await tx.superAdminEmailChange.findUnique({ where: { superAdminId } });
      // A resend can only rotate the password-authorized request for this owner.
      if (previousRequestId && (!previous || previous.otpRequestId !== previousRequestId || previous.authVersion !== user.authVersion || previous.newEmail !== newEmail || !["PENDING_DELIVERY", "SENT", "LOCKED", "FAILED"].includes(previous.state)))
        throw new ServiceError("EMAIL_CHANGE_INVALID", 400, "This email request is no longer current. Refresh settings before requesting another code.");
      // Re-entering the current password starts a fresh request immediately.
      // Only the dedicated resend action waits for the one-minute cooldown.
      if (previousRequestId && previous && ["PENDING_DELIVERY", "SENT", "LOCKED", "FAILED"].includes(previous.state) && now.getTime() - previous.createdAt.getTime() < 60000)
        throw new ServiceError("RATE_LIMITED", 429, "Wait a minute before requesting another verification code.");
      const data = { newEmail, tokenHash, otpRequestId, failedAttempts: 0, authVersion: user.authVersion, state: "PENDING_DELIVERY", createdAt: now, expiresAt, consumedAt: null };
      await tx.superAdminEmailChange.upsert({ where: { superAdminId }, create: { superAdminId, ...data }, update: data });
      await this.audit(tx, superAdminId, "EMAIL_CHANGE_REQUESTED", "SUCCESS");
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    try {
      await this.mailer.send({ to: newEmail, subject: "Your HRMS Super Admin email verification code",
        text: `Your HRMS Super Admin email verification code is: ${code}\n\nEnter this six-digit code at ${this.origin}/super-admin/settings to confirm your new email address. It expires in 10 minutes and can be used only once. Your current email remains active until you enter the correct code. If you did not request this change, ignore this email.` });
    } catch {
      await this.db.$transaction(async (tx) => {
        await tx.superAdminEmailChange.updateMany({ where: { superAdminId, tokenHash, state: "PENDING_DELIVERY" }, data: { state: "FAILED", consumedAt: this.clock() } });
        await this.audit(tx, superAdminId, "EMAIL_CHANGE_FAILED", "FAILED", "DELIVERY_FAILED");
      });
      throw new ServiceError("EMAIL_DELIVERY_FAILED", 503, "Verification email delivery could not be confirmed. Your current email and sign-in are unchanged. Please try again later.");
    }
    const accepted = await this.db.$transaction(async (tx) => {
      await tx.superAdmin.updateMany({ where: { id: superAdminId }, data: { updatedAt: this.clock() } });
      const updated = await tx.superAdminEmailChange.updateMany({ where: { superAdminId, tokenHash, state: "PENDING_DELIVERY", authVersion: user.authVersion, expiresAt: { gt: this.clock() }, superAdmin: { isActive: true, authVersion: user.authVersion } }, data: { state: "SENT" } });
      if (updated.count) await this.audit(tx, superAdminId, "EMAIL_CHANGE_SENT", "SUCCESS");
      return updated.count === 1;
    });
    if (!accepted) throw new ServiceError("REQUEST_SUPERSEDED", 409, "This request is no longer current. Your current email is unchanged. Request a new verification code.");
    return { newEmail, createdAt: now, expiresAt, requestId: otpRequestId, message: "A verification code has been sent to your new email address. Enter the six-digit OTP below to update your email." };
  }
  async confirmEmail(superAdminId: string, sessionToken: string, requestId: string, code: string) {
    const user = await this.db.superAdmin.findUnique({ where: { id: superAdminId }, select: { id: true, email: true, passwordHash: true, authVersion: true, isActive: true } });
    if (!user?.isActive) throw new ServiceError("FORBIDDEN", 403, "Super Admin access is required.");
    try {
      const rejection = await this.db.$transaction(async (tx) => {
        await this.lock(tx, user, sessionToken);
        const pending = await tx.superAdminEmailChange.findUnique({ where: { superAdminId } });
        if (!pending || pending.otpRequestId !== requestId || pending.authVersion !== user.authVersion || pending.state !== "SENT" || pending.consumedAt || pending.expiresAt <= this.clock() || pending.failedAttempts >= MAX_OTP_ATTEMPTS)
          throw new ServiceError("EMAIL_CHANGE_INVALID", 400, "This verification code is expired, unavailable or already used. Your current email is unchanged; request a new code.");
        const expected = Buffer.from(pending.tokenHash, "hex"), actual = Buffer.from(hashToken(`email-change:${requestId}:${code}`), "hex");
        if (!timingSafeEqual(expected, actual)) {
          const failedAttempts = pending.failedAttempts + 1, locked = failedAttempts >= MAX_OTP_ATTEMPTS;
          await tx.superAdminEmailChange.update({ where: { superAdminId }, data: { failedAttempts, ...(locked ? { state: "LOCKED", consumedAt: this.clock() } : {}) } });
          await this.audit(tx, superAdminId, "EMAIL_CHANGE_REJECTED", "FAILED", locked ? "OTP_ATTEMPTS_EXCEEDED" : "INCORRECT_OTP");
          // Return the error so the failed-attempt counter is committed, not rolled back.
          return new ServiceError(locked ? "OTP_ATTEMPTS_EXCEEDED" : "INCORRECT_OTP", 400, locked ? "Too many incorrect codes. Request a new verification code. Your email has not changed." : "The verification code is incorrect. Check your email and try again.");
        }
        if (await tx.superAdmin.count({ where: { email: pending.newEmail, id: { not: superAdminId } } }))
          throw new ServiceError("EMAIL_UNAVAILABLE", 409, "That email address cannot be used. Your current email is unchanged; request a different address.");
        await tx.superAdmin.update({ where: { id: superAdminId }, data: { email: pending.newEmail, emailVerifiedAt: this.clock(), authVersion: { increment: 1 } } });
        await tx.superAdminEmailChange.update({ where: { superAdminId }, data: { state: "COMPLETED", consumedAt: this.clock() } });
        await tx.superAdminSession.deleteMany({ where: { superAdminId } });
        await this.audit(tx, superAdminId, "EMAIL_CHANGED", "SUCCESS");
        return null;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
      if (rejection) throw rejection;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
        throw new ServiceError("EMAIL_UNAVAILABLE", 409, "That email address cannot be used. Your current email is unchanged.");
      throw error;
    }
    return { requiresReauthentication: true, message: "Your new email is verified and now active. All sessions were signed out. Sign in again using your new email and existing password." };
  }
  async changePassword(superAdminId: string, sessionToken: string, currentPassword: string, newPassword: string) {
    const user = await this.authenticate(superAdminId, currentPassword, "PASSWORD_CHANGE_REJECTED");
    if (newPassword === currentPassword) throw new ServiceError("PASSWORD_UNCHANGED", 400, "Choose a new password different from your current password.");
    const passwordHash = await hashPassword(newPassword);
    await this.db.$transaction(async (tx) => {
      await this.lock(tx, user, sessionToken);
      await tx.superAdmin.update({ where: { id: superAdminId }, data: { passwordHash, authVersion: { increment: 1 } } });
      await tx.superAdminSession.deleteMany({ where: { superAdminId } });
      await tx.superAdminEmailChange.updateMany({ where: { superAdminId, state: { in: ["PENDING_DELIVERY", "SENT"] } }, data: { state: "CANCELLED", consumedAt: this.clock() } });
      await this.audit(tx, superAdminId, "PASSWORD_CHANGED", "SUCCESS");
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    return { requiresReauthentication: true, message: "Your password was changed. All active sessions were signed out. Sign in again with your new password." };
  }
}
