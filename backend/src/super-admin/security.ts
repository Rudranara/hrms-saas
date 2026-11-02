import type { PrismaClient } from "@prisma/client";
import type { RequestHandler } from "express";
import { hashToken, readSessionToken } from "../auth/security";

export const PLATFORM_COOKIE = "hrms_platform_session";
declare global {
  namespace Express {
    interface Request { platformAuth?: { superAdminId: string }; }
  }
}
export const readPlatformSession = (req: Parameters<RequestHandler>[0]) => readSessionToken(req, PLATFORM_COOKIE);
export function requireSuperAdmin(db: PrismaClient): RequestHandler {
  return async (req, res, next) => {
    try {
      const token = readPlatformSession(req);
      const session = token ? await db.superAdminSession.findUnique({ where: { tokenHash: hashToken(token) }, select: { expiresAt: true, authVersion: true, superAdmin: { select: { id: true, isActive: true, authVersion: true } } } }) : null;
      if (!session || !session.superAdmin.isActive || session.expiresAt.getTime() <= Date.now() || session.authVersion !== session.superAdmin.authVersion) {
        res.status(401).json({ success: false, message: "Your platform session ended. Sign in again." }); return;
      }
      req.platformAuth = { superAdminId: session.superAdmin.id }; next();
    } catch (error) { next(error); }
  };
}
