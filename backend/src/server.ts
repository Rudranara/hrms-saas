import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import helmet from "helmet";
import { Prisma, type PrismaClient } from "@prisma/client";
import { authRouter } from "./auth/routes";
import { recoveryRouter } from "./auth/recovery";
import { billingRouter, billingWebhook } from "./billing/routes";
import { createServices, type ServiceOverrides } from "./services";
import { ServiceError } from "./services/errors";
import { superAdminRouter } from "./super-admin/routes";
import { superAdminAccountRouter } from "./super-admin/account-routes";
import { superAdminManagementRouter } from "./super-admin/admin-routes";
import { organizationAccessRouter } from "./super-admin/organization-access-routes";
import { superAdminAuthRouter } from "./super-admin/auth";
import {
  requireAuthentication,
  requireOwnOrganization,
  requireRole,
  requireTrustedMutation,
} from "./auth/security";

export type AppConfiguration = { frontendOrigin: string; production: boolean };
export function configuration(): AppConfiguration {
  const production = process.env.NODE_ENV === "production";
  if (production && !process.env.FRONTEND_URL)
    throw new Error("FRONTEND_URL must be configured in production.");
  const url = new URL(process.env.FRONTEND_URL || "http://localhost:3000");
  if (process.env.APP_ORIGIN && new URL(process.env.APP_ORIGIN).origin !== url.origin) throw new Error("APP_ORIGIN must match FRONTEND_URL.");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (production && url.protocol !== "https:")
  )
    throw new Error(
      "FRONTEND_URL must be a valid origin (HTTPS in production).",
    );
  return { frontendOrigin: url.origin, production };
}
export function createApp(
  db: PrismaClient,
  config: AppConfiguration,
  overrides: ServiceOverrides = {},
) {
  const app = express();
  const services = createServices(db, config.frontendOrigin, overrides);
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(
    cors({
      origin: config.frontendOrigin,
      credentials: true,
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type", "X-HRMS-Request"],
    }),
  );
  app.post(
    "/api/billing/webhook",
    express.raw({ type: "application/json", limit: "256kb", inflate: false }),
    billingWebhook(db, services),
  );
  app.use(express.json({ limit: "16kb", inflate: false }));
  app.get("/api/health", (_req, res) =>
    res.json({ success: true, message: "HRMS API is running" }),
  );
  app.get("/api/health/database", async (_req, res) => {
    try {
      await db.$queryRaw`SELECT 1`;
      res.json({ success: true, database: "connected" });
    } catch {
      res.status(503).json({ success: false, database: "unavailable" });
    }
  });
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store, private");
    next();
  });
  app.use("/api", requireTrustedMutation(config.frontendOrigin));
  app.use(
    "/api/auth",
    recoveryRouter(db, services.recovery, config.production),
  );
  app.use("/api/auth", authRouter(db, config.production, services));
  app.use("/api/billing", billingRouter(db, services));
  app.use("/api/super-admin/auth", superAdminAuthRouter(db, config.production, services.clock, services.recovery.mailer, config.frontendOrigin));
  app.use("/api/super-admin/account", superAdminAccountRouter(db, services.recovery.mailer, config.frontendOrigin, services.clock, config.production));
  app.use("/api/super-admin/admins", superAdminManagementRouter(db, services.clock));
  app.use("/api/super-admin", organizationAccessRouter(db, services.access, services.clock));
  app.use("/api/super-admin", superAdminRouter(db, services.clock, services.access.graceHours));
  const authenticate = requireAuthentication(db);
  const administrator = requireRole("ORGANIZATION_ADMIN");
  const ownOrganization: express.RequestHandler = async (req, res, next) => {
    try {
      // The authenticated session is always authoritative, never a URL/query ID.
      const organization = await db.organization.findUnique({
        where: { id: req.auth!.organizationId },
        select: {
          id: true,
          name: true,
          trialStartedAt: true,
          trialExpiresAt: true,
        },
      });
      if (!organization) {
        res
          .status(404)
          .json({ success: false, message: "Organization not found." });
        return;
      }
      res.json({ success: true, organization });
    } catch (error) {
      next(error);
    }
  };
  // All business endpoints use this policy chain. Auth, recovery, and billing
  // intentionally remain outside it so expired accounts can restore access.
  app.get(
    "/api/organization",
    authenticate,
    administrator,
    services.access.requireSubscription,
    ownOrganization,
  );
  app.get(
    "/api/organizations/:organizationId",
    authenticate,
    administrator,
    requireOwnOrganization,
    services.access.requireSubscription,
    ownOrganization,
  );
  app.use((_req, res) =>
    res.status(404).json({ success: false, message: "Endpoint not found." }),
  );
  const handleError: ErrorRequestHandler = (
    error: unknown,
    _req,
    res,
    _next,
  ) => {
    if (error instanceof ServiceError) {
      res
        .status(error.status)
        .json({ success: false, code: error.code, message: error.message });
      return;
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "type" in error &&
      error.type === "encoding.unsupported"
    ) {
      res.status(415).json({
        success: false,
        message: "Compressed request bodies are not supported.",
      });
      return;
    }
    if (
      error instanceof SyntaxError ||
      (typeof error === "object" &&
        error !== null &&
        "type" in error &&
        error.type === "entity.too.large")
    ) {
      res
        .status(400)
        .json({ success: false, message: "Invalid request body." });
      return;
    }
    // Do not log raw Prisma errors: they may contain connection strings or input.
    const databaseError =
      error instanceof Prisma.PrismaClientKnownRequestError ||
      error instanceof Prisma.PrismaClientInitializationError ||
      error instanceof Prisma.PrismaClientUnknownRequestError;
    console.error(
      databaseError
        ? "Database request unavailable."
        : "Request could not be completed.",
    );
    res.status(databaseError ? 503 : 500).json({
      success: false,
      message: databaseError
        ? "The service is temporarily unavailable. Please try again."
        : "Something went wrong. Please try again.",
    });
  };
  app.use(handleError);
  return app;
}
