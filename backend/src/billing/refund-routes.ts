import { Router } from "express";
import { z } from "zod";
import { rateLimit } from "express-rate-limit";
import type { PrismaClient } from "@prisma/client";
import type { Services } from "../services";
import { requireAuthentication, requireRole } from "../auth/security";
import { requireSuperAdmin, readPlatformSession } from "../super-admin/security";
import { ServiceError } from "../services/errors";
import { refundStatuses } from "./refunds";

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const querySchema = z.strictObject({ page: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().max(10000)).default(1), status: z.enum(refundStatuses).optional(), q: z.string().trim().max(120).default("") });
const limit = () => rateLimit({ windowMs: 15 * 60000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false, message: { success: false, message: "Too many refund requests. Please try again later." } });
function parse<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) throw new ServiceError("VALIDATION_ERROR", 400, result.error.issues[0]?.message || "Check the refund request."); return result.data; }
export function organizationRefundRouter(db: PrismaClient, services: Services) {
  const router = Router(); router.use(requireAuthentication(db), requireRole("ORGANIZATION_ADMIN"));
  router.get("/", async (req, res) => { const query = parse(querySchema, req.query); res.json({ success: true, ...await services.refunds.list(req.auth!.organizationId, query.page, query.status, query.q) }); });
  router.post("/", limit(), async (req, res) => {
    const input = parse(z.strictObject({ paymentId: identifier, reason: z.string().trim().min(5).max(1000), requestId: z.string().uuid() }), req.body);
    res.status(201).json({ success: true, ...await services.refunds.submit(req.auth!.organizationId, req.auth!.userId, input.paymentId, input.reason, input.requestId), message: "Refund request submitted for review. No refund or cancellation has been issued." });
  });
  router.post("/:id/refresh", limit(), async (req, res) => { parse(z.strictObject({}), req.body); res.json(await services.refunds.refresh(parse(identifier, req.params.id), req.auth!.organizationId)); });
  return router;
}
export function platformRefundRouter(db: PrismaClient, services: Services) {
  const router = Router(); router.use(requireSuperAdmin(db));
  router.get("/", async (req, res) => { const query = parse(querySchema, req.query); res.json({ success: true, ...await services.refunds.list(undefined, query.page, query.status, query.q) }); });
  router.post("/:id/decision", limit(), async (req, res) => {
    const input = parse(z.discriminatedUnion("action", [
      z.strictObject({ action: z.literal("APPROVE"), requestId: z.string().uuid(), expectedVersion: z.number().int().nonnegative(), amountMinor: z.number().int().positive().max(2147483647), confirmed: z.literal(true) }),
      z.strictObject({ action: z.literal("REJECT"), requestId: z.string().uuid(), expectedVersion: z.number().int().nonnegative(), reason: z.string().trim().min(5).max(1000) }),
    ]), req.body);
    res.json(await services.refunds.decide(parse(identifier, req.params.id), req.platformAuth!.superAdminId, readPlatformSession(req)!, input));
  });
  router.post("/:id/refresh", limit(), async (req, res) => { parse(z.strictObject({}), req.body); res.json(await services.refunds.refresh(parse(identifier, req.params.id))); });
  router.post("/:id/prepared", limit(), async (req, res) => {
    const common = { requestId: z.string().uuid(), expectedVersion: z.number().int().nonnegative(), reason: z.string().trim().min(5).max(500), confirmed: z.literal(true) };
    const input = parse(z.discriminatedUnion("action", [
      z.strictObject({ ...common, action: z.literal("AMEND"), amountMinor: z.number().int().positive().max(2147483647) }),
      z.strictObject({ ...common, action: z.literal("VOID") }),
    ]), req.body);
    res.json(await services.refunds.changePrepared(parse(identifier, req.params.id), req.platformAuth!.superAdminId, readPlatformSession(req)!, input));
  });
  router.post("/:id/process", limit(), async (req, res) => {
    const input = parse(z.strictObject({ confirmed: z.literal(true), amountMinor: z.number().int().positive().max(2147483647) }), req.body);
    res.json(await services.refunds.processApproved(parse(identifier, req.params.id), req.platformAuth!.superAdminId, readPlatformSession(req)!, input.amountMinor));
  });
  return router;
}
