import { Router } from "express";
import { z } from "zod";
import { rateLimit } from "express-rate-limit";
import type { PrismaClient } from "@prisma/client";
import type { AccessPolicy } from "../billing/access";
import { ServiceError, type Clock } from "../services/errors";
import { requireSuperAdmin, readPlatformSession } from "./security";
import { OrganizationAccessService, accessChange } from "./organization-access";

export function organizationAccessRouter(db: PrismaClient, access: AccessPolicy, clock: Clock) {
  const router = Router(), service = new OrganizationAccessService(db, access, clock);
  router.use("/organizations/:id/access", requireSuperAdmin(db), rateLimit({ windowMs: 15 * 60000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false,
    message: { success: false, code: "RATE_LIMITED", message: "Too many access-management requests. Please try again later." } }));
  const identifier = (value: unknown) => { const result = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).safeParse(value); if (!result.success) throw new ServiceError("VALIDATION_ERROR", 400, "Invalid organization identifier."); return result.data; };
  router.get("/organizations/:id/access", async (req, res) => {
    const query = z.strictObject({ page: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().max(10000)).default(1) }).safeParse(req.query);
    if (!query.success) throw new ServiceError("VALIDATION_ERROR", 400, "Choose a valid audit-history page.");
    res.json({ success: true, ...await service.get(identifier(req.params.id), query.data.page) });
  });
  router.post("/organizations/:id/access", async (req, res) => {
    if (Object.keys(req.query).length) throw new ServiceError("VALIDATION_ERROR", 400, "Query parameters are not accepted for access changes.");
    const input = accessChange.safeParse(req.body);
    if (!input.success) throw new ServiceError("VALIDATION_ERROR", 400, input.error.issues[0]?.message || "Check the access settings.");
    res.json({ success: true, ...await service.change(identifier(req.params.id), req.platformAuth!.superAdminId, readPlatformSession(req)!, input.data) });
  });
  return router;
}
