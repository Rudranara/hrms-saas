import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { hashPassword, verifyPassword } from "../auth/password";
import { cookieOptions, hashToken, newSession, SESSION_MS } from "../auth/security";
import { PLATFORM_COOKIE, readPlatformSession, requireSuperAdmin } from "./security";
import type { Clock } from "../services/errors";
import { ServiceError } from "../services/errors";
import type { Mailer } from "../services/mail";
import { SuperAdminRecoveryService } from "./recovery";

const credentials = z.strictObject({ email: z.string().trim().toLowerCase().max(254).email(), password: z.string().min(1).max(128) });
const recoveryRequest = z.strictObject({ email: z.string().trim().toLowerCase().max(254).email(), resend: z.boolean().default(false) });
const recoveryVerify = z.strictObject({ email: z.string().trim().toLowerCase().max(254).email(), code: z.string().regex(/^\d{8}$/) });
const recoveryReset = recoveryVerify.extend({ password: z.string().min(8).max(128), confirmPassword: z.string().max(128) }).refine((value) => value.password === value.confirmPassword, { path: ["confirmPassword"], message: "Passwords do not match." });
export const publicSuperAdmin = { id: true, fullName: true, email: true, emailVerifiedAt: true } as const;
export function superAdminAuthRouter(db: PrismaClient, production: boolean, clock: Clock, mailer: Mailer, origin: string) {
  const router = Router(), dummyHash = hashPassword("Public timing placeholder, never an account");
  const recovery = new SuperAdminRecoveryService(db, mailer, origin, clock);
  const denied = { success: false, message: "Unable to sign in. Check your credentials or contact your platform administrator." };
  router.post("/login", rateLimit({ windowMs: 15 * 60000, limit: 20, skipSuccessfulRequests: true, standardHeaders: "draft-8", legacyHeaders: false,
    message: { success: false, message: "Too many attempts. Please try again in 15 minutes." } }), async (req, res) => {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) { res.status(400).json(denied); return; }
    const account = await db.superAdmin.findUnique({ where: { email: parsed.data.email } });
    const valid = await verifyPassword(parsed.data.password, account?.passwordHash ?? await dummyHash);
    if (!account || !valid || !account.isActive) { res.status(401).json(denied); return; }
    const session = newSession(), previous = readPlatformSession(req);
    const admin = await db.$transaction(async (tx) => {
      const locked = await tx.superAdmin.updateMany({ where: { id: account.id, email: account.email, passwordHash: account.passwordHash, authVersion: account.authVersion, isActive: true }, data: { updatedAt: clock() } });
      if (!locked.count) return null;
      if (previous) await tx.superAdminSession.deleteMany({ where: { tokenHash: hashToken(previous), superAdminId: account.id } });
      await tx.superAdminSession.create({ data: { superAdminId: account.id, tokenHash: session.tokenHash, expiresAt: session.expiresAt, authVersion: account.authVersion } });
      return tx.superAdmin.findUniqueOrThrow({ where: { id: account.id }, select: publicSuperAdmin });
    });
    if (!admin) { res.status(401).json(denied); return; }
    res.cookie(PLATFORM_COOKIE, session.token, { ...cookieOptions(production), maxAge: SESSION_MS });
    res.json({ success: true, admin });
  });
  router.get("/me", requireSuperAdmin(db), async (req, res) => {
    res.json({ success: true, admin: await db.superAdmin.findUniqueOrThrow({ where: { id: req.platformAuth!.superAdminId }, select: publicSuperAdmin }) });
  });
  router.post("/logout", async (req, res) => {
    const token = readPlatformSession(req);
    if (token) await db.superAdminSession.deleteMany({ where: { tokenHash: hashToken(token) } });
    res.clearCookie(PLATFORM_COOKIE, cookieOptions(production)); res.json({ success: true });
  });
  const recoveryLimit = rateLimit({ windowMs: 15 * 60000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false, message: { success: false, code: "RATE_LIMITED", message: "Too many requests. Please try again later." } });
  router.post("/forgot-password", recoveryLimit, async (req, res) => {
    const body = recoveryRequest.safeParse(req.body);
    if (!body.success) throw new ServiceError("VALIDATION_ERROR", 400, "Enter a valid email address.");
    res.status(202).json({ success: true, ...await recovery.request(body.data.email, body.data.resend) });
  });
  router.post("/reset/verify-otp", recoveryLimit, async (req, res) => {
    const body = recoveryVerify.safeParse(req.body);
    if (!body.success) throw new ServiceError("VALIDATION_ERROR", 400, "Enter the eight-digit code from your email.");
    res.json({ success: true, ...await recovery.verify(body.data.email, body.data.code) });
  });
  router.post("/reset-password", recoveryLimit, async (req, res) => {
    const body = recoveryReset.safeParse(req.body);
    if (!body.success) throw new ServiceError("VALIDATION_ERROR", 400, "Use 8–128 characters and matching passwords.");
    const result = await recovery.consume(body.data.email, body.data.code, body.data.password);
    res.clearCookie(PLATFORM_COOKIE, cookieOptions(production));
    res.json({ success: true, ...result });
  });
  return router;
}
