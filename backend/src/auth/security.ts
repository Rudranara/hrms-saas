import { createHash, randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { PrismaClient, UserRole } from "@prisma/client";

export const SESSION_COOKIE = "hrms_session";
export const VERIFICATION_COOKIE = "hrms_verification";
export const SESSION_MS = 12 * 60 * 60 * 1000;
export const TRIAL_MS = 7 * 24 * 60 * 60 * 1000;
export type AuthContext = {
  userId: string;
  organizationId: string;
  role: UserRole;
};
declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export function newSession() {
  const token = randomBytes(32).toString("hex");
  return {
    token,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + SESSION_MS),
  };
}
export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
export function readSessionToken(req: Request, name = SESSION_COOKIE) {
  const cookie = req.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  const value = cookie?.slice(name.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}
export function cookieOptions(production: boolean) {
  return {
    httpOnly: true,
    secure: production,
    sameSite: "lax" as const,
    path: "/",
  };
}
export function requireTrustedMutation(origin: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    if (
      req.get("origin") !== origin ||
      req.get("x-hrms-request") !== "1" ||
      !req.is("application/json")
    ) {
      res.status(403).json({
        success: false,
        message: "Request origin or CSRF protection could not be verified.",
      });
      return;
    }
    next();
  };
}
export function requireAuthentication(db: PrismaClient, verificationOnly = false) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = verificationOnly
        ? readSessionToken(req, VERIFICATION_COOKIE) || readSessionToken(req)
        : readSessionToken(req);
      const session = token
        ? await db.session.findUnique({
            where: { tokenHash: hashToken(token) },
            select: {
              expiresAt: true,
              authVersion: true,
              user: {
                select: {
                  id: true,
                  organizationId: true,
                  role: true,
                  authVersion: true,
                  emailVerifiedAt: true,
                },
              },
            },
          })
        : null;
      if (
        !session ||
        session.expiresAt.getTime() <= Date.now() ||
        !(verificationOnly
          ? session.authVersion === -(session.user.authVersion + 1) || session.authVersion === session.user.authVersion
          : session.authVersion === session.user.authVersion)
      ) {
        res
          .status(401)
          .json({ success: false, message: "Please sign in to continue." });
        return;
      }
      req.auth = {
        userId: session.user.id,
        organizationId: session.user.organizationId,
        role: session.user.role,
      };
      next();
    } catch (error) {
      next(error);
    }
  };
}
export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      res.status(403).json({
        success: false,
        message: "You do not have permission to access this resource.",
      });
      return;
    }
    next();
  };
}
// Reuse this scope on every future organization-owned Prisma query.
export function organizationScope(auth: AuthContext) {
  return { organizationId: auth.organizationId };
}
export function requireOwnOrganization(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!req.auth || req.params.organizationId !== req.auth.organizationId) {
    res.status(403).json({
      success: false,
      message: "You do not have permission to access this organization.",
    });
    return;
  }
  next();
}
