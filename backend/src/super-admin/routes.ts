import { Router } from "express";
import { z } from "zod";
import { rateLimit } from "express-rate-limit";
import type { PrismaClient } from "@prisma/client";
import { requireSuperAdmin } from "./security";
import { ServiceError, type Clock } from "../services/errors";
import { classifications, SuperAdminService } from "./service";

const page = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().max(10000)).default(1);
const pageSize = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().max(50)).default(20);
const pagination = z.strictObject({ page, pageSize });
const listing = pagination.extend({ q: z.string().trim().max(120).optional(), status: z.enum(classifications).default("ALL") });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(value + "T00:00:00Z");
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const dates = z.strictObject({ from: date.optional(), to: date.optional() });
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ServiceError("VALIDATION_ERROR", 400, "Invalid report filters. Use valid dates, supported statuses and pages of at most 50 rows.");
  return result.data;
}
export function reportRange(query: unknown, now: Date) {
  const values = parse(dates, query);
  const today = new Date(now.getTime() + 330 * 60000).toISOString().slice(0, 10);
  const fromDate = values.from || new Date(new Date(today + "T00:00:00Z").getTime() - 29 * 86400000).toISOString().slice(0, 10);
  const toDate = values.to || today;
  const from = new Date(fromDate + "T00:00:00+05:30");
  const until = new Date(new Date(toDate + "T00:00:00+05:30").getTime() + 86400000);
  if (until <= from || until.getTime() - from.getTime() > 366 * 86400000)
    throw new ServiceError("VALIDATION_ERROR", 400, "Choose an ordered date range of at most 366 days.");
  return { from, until, fromDate, toDate };
}
export function superAdminRouter(db: PrismaClient, clock: Clock, graceHours?: number) {
  const router = Router(), service = new SuperAdminService(db, clock, graceHours);
  router.use(requireSuperAdmin(db));
  router.use(rateLimit({ windowMs: 60000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false,
    message: { success: false, message: "Too many reporting requests. Please try again shortly." } }));
  router.get("/metrics", async (req, res) => res.json({ success: true, ...await service.metrics(reportRange(req.query, clock())) }));
  router.get("/revenue", async (req, res) => res.json({ success: true, revenue: await service.revenue(reportRange(req.query, clock())) }));
  router.get("/organizations", async (req, res) => res.json({ success: true, ...await service.organizations(parse(listing, req.query)) }));
  router.use("/organizations/:id", (req, _res, next) => {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(String(req.params.id))) throw new ServiceError("VALIDATION_ERROR", 400, "Invalid organization identifier.");
    next();
  });
  router.get("/organizations/:id", async (req, res) => {
    parse(z.strictObject({}), req.query);
    res.json({ success: true, organization: await service.organization(String(req.params.id)) });
  });
  router.get("/organizations/:id/subscriptions", async (req, res) => res.json({ success: true, ...await service.subscriptions(String(req.params.id), parse(pagination, req.query)) }));
  router.get("/organizations/:id/payments", async (req, res) => res.json({ success: true, ...await service.payments(String(req.params.id), parse(pagination, req.query)) }));
  return router;
}
