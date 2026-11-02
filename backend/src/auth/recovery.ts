import { randomBytes, randomInt } from "node:crypto";
import { Router } from "express";
import { Prisma, type PrismaClient, type TokenPurpose } from "@prisma/client";
import { z } from "zod";
import { rateLimit } from "express-rate-limit";
import {
  hashToken,
  requireAuthentication,
  cookieOptions,
  SESSION_COOKIE,
  SESSION_MS,
  VERIFICATION_COOKIE,
  newSession,
} from "./security";
import { hashPassword } from "./password";
import type { Mailer } from "../services/mail";
import { ServiceError, type Clock } from "../services/errors";

const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/, "The link is invalid.");
const tokenBody = z.strictObject({ token: tokenSchema });
const emailSchema = z.string().trim().toLowerCase().max(254).email();
const resetBody = z
  .strictObject({
    email: emailSchema,
    code: z.string().regex(/^\d{8}$/, "Enter the eight-digit code from your email."),
    password: z.string().min(8).max(128),
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });
const resetOtpBody = z.strictObject({
  email: emailSchema,
  code: z.string().regex(/^\d{8}$/, "Enter the eight-digit code from your email."),
});
function duration(value: string | undefined, fallback: number) {
  const number = value === undefined ? fallback : Number(value);
  return Number.isInteger(number) && number >= 5 && number <= 1440
    ? number
    : fallback;
}
function invalidToken(code = "TOKEN_INVALID"): never {
  throw new ServiceError(
    code,
    code === "TOKEN_USED" ? 409 : 400,
    code === "TOKEN_EXPIRED"
      ? "This link has expired. Request a new email."
      : code === "TOKEN_USED"
        ? "This link has already been used. Request a new email or sign in."
        : "This link is invalid. Request a new email.",
  );
}
export class AccountRecovery {
  private deliveries = new Set<Promise<unknown>>();
  constructor(
    private db: PrismaClient,
    public mailer: Mailer,
    private origin: string,
    private clock: Clock,
    private verificationMinutes = duration(
      process.env.EMAIL_VERIFY_TTL_MINUTES,
      1440,
    ),
    private resetMinutes = duration(process.env.PASSWORD_RESET_TTL_MINUTES, 30),
  ) {}
  async flush() {
    await Promise.allSettled([...this.deliveries]);
  }
  private async issue(userId: string, purpose: TokenPurpose, enforceCooldown = true) {
    const token = purpose === "RESET_PASSWORD"
      ? String(randomInt(10_000_000, 100_000_000))
      : randomBytes(32).toString("hex"),
      now = this.clock();
    const result = await this.db.$transaction(
      async (tx) => {
        // One lock order (user, then token) serializes issuance and consumption.
        const user = await tx.user.update({
          where: { id: userId },
          data: { updatedAt: now },
          select: {
            id: true,
            email: true,
            authVersion: true,
            emailVerifiedAt: true,
          },
        });
        if (purpose === "VERIFY_EMAIL" && user.emailVerifiedAt) return null;
        const previous = await tx.accountToken.findUnique({
          where: { userId_purpose: { userId, purpose } },
        });
        if (
          enforceCooldown && previous &&
          now.getTime() - previous.createdAt.getTime() < 60000 &&
          !previous.consumedAt
        )
          throw new ServiceError(
            "RATE_LIMITED",
            429,
            "Please wait a minute before requesting another email.",
          );
        const data = {
          tokenHash: hashToken(token),
          authVersion: user.authVersion,
          expiresAt: new Date(
            now.getTime() +
              (purpose === "VERIFY_EMAIL"
                ? this.verificationMinutes
                : this.resetMinutes) *
                60000,
          ),
          consumedAt: null,
          createdAt: now,
        };
        await tx.accountToken.upsert({
          where: { userId_purpose: { userId, purpose } },
          create: { userId, purpose, ...data },
          update: data,
        });
        return { email: user.email, token, hash: data.tokenHash, createdAt: now };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    return result;
  }
  private async deliver(
    issued: { email: string; token: string; hash: string },
    purpose: TokenPurpose,
  ) {
    const link = `${this.origin}/verify-email#token=${issued.token}`;
    try {
      await this.mailer.send({
        to: issued.email,
        subject:
          purpose === "VERIFY_EMAIL"
            ? "Verify your HRMS email"
            : "Your HRMS password reset code",
        text: purpose === "VERIFY_EMAIL"
          ? `Confirm your email address using this single-use link:\n\n${link}\n\nThis link expires in ${this.verificationMinutes} minutes. If you did not request this, you can ignore this email.`
          : `Your HRMS password reset code is: ${issued.token}\n\nEnter this eight-digit code at ${this.origin}/reset-password. It expires in ${this.resetMinutes} minutes and can be used only once. If you did not request this, you can ignore this email.`,
      });
    } catch (error) {
      await this.db.accountToken.updateMany({
        where: { tokenHash: issued.hash, consumedAt: null },
        data: { consumedAt: this.clock() },
      });
      console.warn(
        "Account email delivery could not be confirmed; no token or recipient was logged.",
      );
      throw error;
    }
  }
  async requestVerification(userId: string) {
    const user = await this.db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { emailVerifiedAt: true },
    });
    if (user.emailVerifiedAt)
      return {
        alreadyVerified: true,
        message: "Your email is already verified.",
      };
    if (!this.mailer.available) {
      console.warn("SMTP is not configured; verification email was not sent.");
      throw new ServiceError(
        this.mailer.configurationError?.code || "EMAIL_UNAVAILABLE",
        503,
        this.mailer.configurationError?.message || "Email delivery is not configured. Contact your administrator.",
      );
    }
    const issued = await this.issue(userId, "VERIFY_EMAIL");
    if (!issued)
      return {
        alreadyVerified: true,
        message: "Your email is already verified.",
      };
    await this.deliver(issued, "VERIFY_EMAIL");
    return {
      accepted: true,
      message:
        "The verification email was accepted for delivery. Check your inbox.",
    };
  }
  async forgot(email: string, resend = false) {
    const started = Date.now();
    let resendAvailableAt: Date | undefined;
    try {
      const user = await this.db.user.findUnique({
        where: { email },
        select: { id: true, emailVerifiedAt: true },
      });
      if (!user)
        throw new ServiceError("ORGANIZATION_ACCOUNT_NOT_FOUND", 404, "No organisation account exists with this email address.");
      if (!this.mailer.available)
        throw new ServiceError("EMAIL_UNAVAILABLE", 503, "Password recovery email is temporarily unavailable. Please try later.");
      // Email entry starts a fresh request; the dedicated resend action waits
      // one minute. Verification-email issuance keeps its existing cooldown.
      const issued = await this.issue(user.id, "RESET_PASSWORD", resend);
      if (issued) {
        resendAvailableAt = new Date(issued.createdAt.getTime() + 60000);
        const delivery = this.deliver(issued, "RESET_PASSWORD")
          .catch(() => {})
          .finally(() => this.deliveries.delete(delivery));
        this.deliveries.add(delivery);
      }
    } finally {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, 350 - (Date.now() - started))),
      );
    }
    return {
      resendAvailableAt,
      message:
        "If an eligible account exists and email delivery is available, you will receive password reset instructions.",
    };
  }
  private async inspect(token: string, purpose: TokenPurpose) {
    const record = await this.db.accountToken.findUnique({
      where: { tokenHash: hashToken(token) },
      include: {
        user: { select: { authVersion: true, emailVerifiedAt: true } },
      },
    });
    if (
      !record ||
      record.purpose !== purpose ||
      record.authVersion !== record.user.authVersion
    )
      invalidToken();
    if (record.consumedAt) invalidToken("TOKEN_USED");
    if (record.expiresAt <= this.clock()) invalidToken("TOKEN_EXPIRED");
    return record;
  }
  async validateReset(token: string) {
    await this.inspect(token, "RESET_PASSWORD");
    return { valid: true };
  }
  async consumeResetOtp(email: string, code: string, password: string) {
    const user = await this.db.user.findUnique({ where: { email }, select: { id: true, authVersion: true, emailVerifiedAt: true } });
    if (!user) invalidToken();
    const now = this.clock();
    const record = await this.db.accountToken.findUnique({ where: { userId_purpose: { userId: user.id, purpose: "RESET_PASSWORD" } } });
    if (!record || record.tokenHash !== hashToken(code) || record.authVersion !== user.authVersion) invalidToken();
    if (record.consumedAt) invalidToken("TOKEN_USED");
    if (record.expiresAt <= now) invalidToken("TOKEN_EXPIRED");
    const passwordHash = await hashPassword(password);
    return this.db.$transaction(async (tx) => {
      const consumed = await tx.accountToken.updateMany({ where: { id: record.id, tokenHash: hashToken(code), consumedAt: null, expiresAt: { gt: now }, authVersion: user.authVersion }, data: { consumedAt: now } });
      if (consumed.count !== 1) invalidToken("TOKEN_USED");
      // A consumed reset OTP proves control of the registered inbox.
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          emailVerifiedAt: user.emailVerifiedAt ?? now,
          authVersion: { increment: 1 },
        },
      });
      await tx.session.deleteMany({ where: { userId: user.id } });
      await tx.accountToken.updateMany({ where: { userId: user.id, consumedAt: null }, data: { consumedAt: now } });
      return { message: "Your password has been updated. Please log in again." };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }
  async validateResetOtp(email: string, code: string) {
    const user = await this.db.user.findUnique({
      where: { email },
      select: { id: true, authVersion: true },
    });
    if (!user) invalidToken();
    const record = await this.db.accountToken.findUnique({
      where: { userId_purpose: { userId: user.id, purpose: "RESET_PASSWORD" } },
    });
    if (!record || record.tokenHash !== hashToken(code) || record.authVersion !== user.authVersion)
      invalidToken();
    if (record.consumedAt) invalidToken("TOKEN_USED");
    if (record.expiresAt <= this.clock()) invalidToken("TOKEN_EXPIRED");
    return { valid: true };
  }
  async consume(token: string, purpose: TokenPurpose, password?: string) {
    const known = await this.inspect(token, purpose);
    const passwordHash =
      purpose === "RESET_PASSWORD" ? await hashPassword(password!) : undefined;
    return this.db.$transaction(
      async (tx) => {
        const now = this.clock();
        const user = await tx.user.update({
          where: { id: known.userId },
          data: { updatedAt: now },
          select: { authVersion: true, emailVerifiedAt: true },
        });
        const consumed = await tx.accountToken.updateMany({
          where: {
            id: known.id,
            tokenHash: hashToken(token),
            purpose,
            consumedAt: null,
            expiresAt: { gt: now },
            authVersion: user.authVersion,
          },
          data: { consumedAt: now },
        });
        if (consumed.count !== 1) invalidToken("TOKEN_USED");
        if (purpose === "VERIFY_EMAIL") {
          await tx.user.update({
            where: { id: known.userId },
            data: { emailVerifiedAt: user.emailVerifiedAt ?? now },
          });
          const session = newSession();
          await tx.session.deleteMany({ where: { userId: known.userId, authVersion: { lt: 0 } } });
          await tx.session.create({ data: {
            tokenHash: session.tokenHash,
            userId: known.userId,
            expiresAt: session.expiresAt,
            authVersion: user.authVersion,
          } });
          return {
            sessionToken: session.token,
            alreadyVerified: !!user.emailVerifiedAt,
            message:
              "Your email is verified. You can return to your workspace.",
          };
        }
        await tx.user.update({
          where: { id: known.userId },
          // A successfully consumed reset code proves control of this inbox.
          data: {
            passwordHash,
            emailVerifiedAt: user.emailVerifiedAt ?? now,
            authVersion: { increment: 1 },
          },
        });
        await tx.session.deleteMany({ where: { userId: known.userId } });
        await tx.accountToken.updateMany({
          where: { userId: known.userId, consumedAt: null },
          data: { consumedAt: now },
        });
        return {
          message: "Your password has been updated. Please log in again.",
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }
}
const limit = (maximum: number) =>
  rateLimit({
    windowMs: 15 * 60000,
    limit: maximum,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      success: false,
      code: "RATE_LIMITED",
      message: "Too many requests. Please try again later.",
    },
  });
export function recoveryRouter(
  db: PrismaClient,
  recovery: AccountRecovery,
  production: boolean,
) {
  const router = Router(),
    auth = requireAuthentication(db, true);
  router.get("/verification-status", auth, async (req, res) => {
    const user = await db.user.findUniqueOrThrow({
      where: { id: req.auth!.userId },
      select: { emailVerifiedAt: true, email: true },
    });
    res.json({
      success: true,
      verified: !!user.emailVerifiedAt,
      verifiedAt: user.emailVerifiedAt,
      deliveryAvailable: recovery.mailer.available,
      deliveryConfigurationError: recovery.mailer.configurationError || null,
      email: user.email,
    });
  });
  router.post("/verification/request", auth, limit(10), async (req, res) => {
    res.json({
      success: true,
      ...(await recovery.requestVerification(req.auth!.userId)),
    });
  });
  router.post("/verification/confirm", limit(30), async (req, res) => {
    const body = tokenBody.safeParse(req.body);
    if (!body.success)
      throw new ServiceError(
        "TOKEN_INVALID",
        400,
        "This link is invalid. Request a new email.",
      );
    const result = await recovery.consume(body.data.token, "VERIFY_EMAIL");
    if ("sessionToken" in result && result.sessionToken) {
      res.cookie(SESSION_COOKIE, result.sessionToken, { ...cookieOptions(production), maxAge: SESSION_MS });
      res.clearCookie(VERIFICATION_COOKIE, cookieOptions(production));
    }
    // Never serialize the bearer token into JSON.
    res.json({ success: true, alreadyVerified: "alreadyVerified" in result && result.alreadyVerified, message: result.message });
  });
  router.post("/forgot-password", limit(20), async (req, res) => {
    const body = z.strictObject({ email: emailSchema, resend: z.boolean().default(false) }).safeParse(req.body);
    if (!body.success)
      throw new ServiceError(
        "VALIDATION_ERROR",
        400,
        "Enter a valid email address.",
      );
    res
      .status(202)
      .json({ success: true, ...(await recovery.forgot(body.data.email, body.data.resend)) });
  });
  router.post("/reset/validate", limit(30), async (req, res) => {
    const body = tokenBody.safeParse(req.body);
    if (!body.success)
      throw new ServiceError(
        "TOKEN_INVALID",
        400,
        "This link is invalid. Request a new email.",
      );
    res.json({
      success: true,
      ...(await recovery.validateReset(body.data.token)),
    });
  });
  router.post("/reset-password", limit(15), async (req, res) => {
    const body = resetBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({
        success: false,
        code: "VALIDATION_ERROR",
        message: "Use 8–128 characters and matching passwords.",
        errors: z.flattenError(body.error).fieldErrors,
      });
      return;
    }
    const result = await recovery.consumeResetOtp(body.data.email, body.data.code, body.data.password);
    res.clearCookie(SESSION_COOKIE, cookieOptions(production));
    res.json({ success: true, ...result });
  });
  router.post("/reset/verify-otp", limit(30), async (req, res) => {
    const body = resetOtpBody.safeParse(req.body);
    if (!body.success)
      throw new ServiceError("VALIDATION_ERROR", 400, "Enter the eight-digit code from your email.");
    res.json({ success: true, ...(await recovery.validateResetOtp(body.data.email, body.data.code)) });
  });
  return router;
}
