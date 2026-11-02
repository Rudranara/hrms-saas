import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { hashPassword } from "../auth/password";
import { hashToken } from "../auth/security";
import { ServiceError, type Clock } from "../services/errors";
import { readPlatformSession, requireSuperAdmin } from "./security";

const publicAdmin = { id: true, fullName: true, email: true, emailVerifiedAt: true, isActive: true, createdAt: true } as const;
const listing = z.strictObject({
  page: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().max(10000)).default(1),
  pageSize: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().max(50)).default(20),
});
const creation = z.strictObject({
  fullName: z.string().trim().min(2, "Enter a name with at least 2 characters.").max(120),
  email: z.string().trim().toLowerCase().max(254).email("Enter a valid email address."),
  password: z.string().min(8, "Use at least 8 characters for the password.").max(128),
  confirmPassword: z.string().max(128),
}).refine((value) => value.password === value.confirmPassword, { path: ["confirmPassword"], message: "Passwords do not match." });
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ServiceError("VALIDATION_ERROR", 400, result.error.issues[0]?.message || "Check the fields and try again.");
  return result.data;
}

// Listing and creation only. Bootstrap and trusted recovery remain CLI-only.
export function superAdminManagementRouter(db: PrismaClient, clock: Clock) {
  const router = Router();
  router.use(requireSuperAdmin(db));
  router.get("/", rateLimit({ windowMs: 60000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false }), async (req, res) => {
    const { page, pageSize } = parse(listing, req.query);
    const [total, items] = await db.$transaction([
      db.superAdmin.count(),
      db.superAdmin.findMany({ select: publicAdmin, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize }),
    ]);
    res.json({ success: true, items, total, page, pageSize });
  });
  router.post("/", rateLimit({ windowMs: 15 * 60000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false,
    message: { success: false, code: "RATE_LIMITED", message: "Too many account creation attempts. Please try again later." },
  }), async (req, res) => {
    parse(z.strictObject({}), req.query);
    const input = parse(creation, req.body), actorId = req.platformAuth!.superAdminId;
    const passwordHash = await hashPassword(input.password);
    try {
      const admin = await db.$transaction(async (tx) => {
        // Serialize with account changes and recheck the creator's live session.
        const locked = await tx.superAdmin.updateMany({ where: { id: actorId, isActive: true }, data: { updatedAt: clock() } });
        if (locked.count !== 1) throw new ServiceError("SESSION_EXPIRED", 401, "Your platform access changed. Sign in again.");
        const actor = await tx.superAdmin.findUniqueOrThrow({ where: { id: actorId }, select: { authVersion: true } });
        const session = await tx.superAdminSession.findUnique({ where: { tokenHash: hashToken(readPlatformSession(req)!) } });
        if (!session || session.superAdminId !== actorId || session.authVersion !== actor.authVersion || session.expiresAt <= clock())
          throw new ServiceError("SESSION_EXPIRED", 401, "Your platform session ended. Sign in again.");
        const created = await tx.superAdmin.create({ data: { fullName: input.fullName, email: input.email, passwordHash, emailVerifiedAt: null }, select: publicAdmin });
        await tx.superAdminAuditEvent.createMany({ data: [
          { actorSuperAdminId: actorId, action: "SUPER_ADMIN_CREATED", outcome: "SUCCESS", reasonCode: "DASHBOARD_CREATION", createdAt: clock() },
          { actorSuperAdminId: created.id, action: "ACCOUNT_PROVISIONED", outcome: "SUCCESS", reasonCode: "ADDITIONAL_ADMIN_DASHBOARD", createdAt: clock() },
        ] });
        return created;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
      res.status(201).json({ success: true, admin, message: "Super admin added successfully. They can now sign in with their email and password." });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
        throw new ServiceError("EMAIL_UNAVAILABLE", 409, "A super-admin account already uses this email address.");
      throw error;
    }
  });
  return router;
}
