import { Router, type Response } from "express";
import { z } from "zod";
import { rateLimit } from "express-rate-limit";
import type { PrismaClient } from "@prisma/client";
import { cookieOptions } from "../auth/security";
import { requireSuperAdmin, readPlatformSession, PLATFORM_COOKIE } from "./security";
import type { Mailer } from "../services/mail";
import { ServiceError, type Clock } from "../services/errors";
import { SuperAdminAccountService } from "./account-service";

const currentPassword = z.string().min(1, "Enter your current password.").max(128);
const emailChange = z.strictObject({ currentPassword, newEmail: z.string().trim().toLowerCase().max(254).email("Enter a valid email address.") });
const resend = z.strictObject({ requestId: z.string().regex(/^[a-f0-9]{64}$/) });
const confirmation = z.strictObject({ requestId: z.string().regex(/^[a-f0-9]{64}$/), code: z.string().trim().regex(/^\d{6}$/, "Enter the six-digit verification code.") });
const passwordChange = z.strictObject({ currentPassword, newPassword: z.string().min(8, "Use at least 8 characters.").max(128), confirmPassword: z.string().max(128) })
  .refine((value) => value.newPassword === value.confirmPassword, { path: ["confirmPassword"], message: "Passwords do not match." });
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ServiceError("VALIDATION_ERROR", 400, parsed.error.issues[0]?.message || "Check the fields and try again.");
  return parsed.data;
}
export function superAdminAccountRouter(db: PrismaClient, mailer: Mailer, origin: string, clock: Clock, production: boolean) {
  const router = Router(), service = new SuperAdminAccountService(db, mailer, origin, clock);
  router.use(requireSuperAdmin(db));
  router.get("/", async (req, res) => {
    parse(z.strictObject({}), req.query);
    res.json({ success: true, ...await service.settings(req.platformAuth!.superAdminId) });
  });
  router.use(rateLimit({ windowMs: 15 * 60000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false,
    message: { success: false, code: "RATE_LIMITED", message: "Too many account-change attempts. Please try again later." } }));
  const clearSession = (res: Response) => {
    res.clearCookie(PLATFORM_COOKIE, cookieOptions(production));
  };
  router.post("/email", async (req, res) => {
    const data = parse(emailChange, req.body);
    res.status(202).json({ success: true, ...await service.requestEmail(req.platformAuth!.superAdminId, readPlatformSession(req)!, data.currentPassword, data.newEmail) });
  });
  router.post("/email/resend", async (req, res) => {
    const data = parse(resend, req.body);
    res.status(202).json({ success: true, ...await service.resendEmail(req.platformAuth!.superAdminId, readPlatformSession(req)!, data.requestId) });
  });
  router.post("/email/confirm", async (req, res) => {
    const data = parse(confirmation, req.body);
    const result = await service.confirmEmail(req.platformAuth!.superAdminId, readPlatformSession(req)!, data.requestId, data.code);
    clearSession(res); res.json({ success: true, ...result });
  });
  router.post("/password", async (req, res) => {
    const data = parse(passwordChange, req.body);
    const result = await service.changePassword(req.platformAuth!.superAdminId, readPlatformSession(req)!, data.currentPassword, data.newPassword);
    clearSession(res); res.json({ success: true, ...result });
  });
  return router;
}
