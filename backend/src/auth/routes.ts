import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { Prisma, type PrismaClient } from "@prisma/client";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { hashPassword, verifyPassword } from "./password";
import type { Services } from "../services";
import { RegistrationService, REGISTRATION_COOKIE } from "./registration";
import {
  cookieOptions,
  hashToken,
  newSession,
  readSessionToken,
  requireAuthentication,
  SESSION_COOKIE,
  SESSION_MS,
  VERIFICATION_COOKIE,
} from "./security";

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .email("Enter a valid work email.");
const password = z
  .string()
  .min(8, "Use at least 8 characters.")
  .max(128, "Use no more than 128 characters.");
const registration = z
  .strictObject({
    organizationName: z
      .string()
      .trim()
      .min(2, "Enter at least 2 characters.")
      .max(120),
    fullName: z.string().trim().min(2, "Enter your full name.").max(120),
    employeeSize: z.enum(["1-10", "11-50", "51-200", "201-500", "501-1000", "1001+"], { error: "Select your organization's employee size." }),
    phoneNumber: z.string().trim().max(32).regex(/^\+?[0-9\s().-]+$/, "Enter a valid phone number.").transform((value) => value.replace(/[\s().-]/g, "")).pipe(z.string().regex(/^\+?[1-9][0-9]{9,14}$/, "Enter a phone number with 10–15 digits.")),
    email,
    password,
    confirmPassword: z.string(),
  })
  .refine((value) => value.password === value.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords do not match.",
  });
const login = z.strictObject({
  email,
  password: z.string().min(1, "Enter your password.").max(128),
});
export const publicUser = {
  id: true,
  fullName: true,
  email: true,
  role: true,
  emailVerifiedAt: true,
  organizationId: true,
  organization: {
    select: {
      id: true,
      name: true,
      trialStartedAt: true,
      trialExpiresAt: true,
    },
  },
} satisfies Prisma.UserSelect;
const limited = (limit: number) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: {
      success: false,
      message: "Too many attempts. Please try again in 15 minutes.",
    },
  });

export function authRouter(
  db: PrismaClient,
  production: boolean,
  services: Services,
) {
  const router = Router();
  const authenticate = requireAuthentication(db);
  const signup = new RegistrationService(db, services.recovery.mailer, services.clock);
  const registrationLimit = rateLimit({ windowMs: 15 * 60000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false, message: { success: false, message: "Too many registration requests. Please try again in 15 minutes." } });
  // Missing accounts still perform the same expensive password verification.
  const dummyHash = hashPassword("A public dummy password, never an account");
  const setSession = (res: Response, token: string) =>
    res.cookie(SESSION_COOKIE, token, {
      ...cookieOptions(production),
      maxAge: SESSION_MS,
    });
  async function removePreviousSession(
    req: Request,
    userId: string,
    tx: Prisma.TransactionClient,
  ) {
    const tokens = [readSessionToken(req), readSessionToken(req, VERIFICATION_COOKIE)].filter((token): token is string => !!token);
    if (tokens.length)
      await tx.session.deleteMany({
        where: { tokenHash: { in: tokens.map(hashToken) }, userId },
      });
  }
  router.post(
    "/register",
    registrationLimit,
    async (req: Request, res: Response, next: NextFunction) => {
      const parsed = registration.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          message: "Please check the highlighted fields.",
          errors: z.flattenError(parsed.error).fieldErrors,
        });
        return;
      }
      try {
        const data = parsed.data;
        const result = await signup.request(data, readSessionToken(req, REGISTRATION_COOKIE));
        res.cookie(REGISTRATION_COOKIE, result.token, { ...cookieOptions(production), maxAge: 60 * 60000 });
        res.status(202).json({ success: true, verificationRequired: true, email: result.email, expiresAt: result.expiresAt, resendAfter: result.resendAfter });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          res.status(409).json({
            success: false,
            message:
              "Unable to register with these details. If you already have an account, please sign in.",
          });
          return;
        }
        next(error);
      }
    },
  );
  router.post("/register/resend", registrationLimit, async (req, res, next) => {
    if (!z.strictObject({}).safeParse(req.body).success) { res.status(400).json({ success: false, message: "Invalid request." }); return; }
    try {
      const token = readSessionToken(req, REGISTRATION_COOKIE);
      if (!token) { res.status(400).json({ success: false, message: "Enter your registration details again." }); return; }
      res.json({ success: true, ...await signup.resend(token) });
    } catch (error) { next(error); }
  });
  router.post("/register/verify", limited(20), async (req, res, next) => {
    const parsed = z.strictObject({ code: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, message: "Enter the six-digit code from your email." }); return; }
    try {
      const token = readSessionToken(req, REGISTRATION_COOKIE);
      if (!token) { res.status(400).json({ success: false, message: "Enter your registration details again." }); return; }
      const result = await signup.verify(token, parsed.data.code);
      setSession(res, result.token);
      res.clearCookie(REGISTRATION_COOKIE, cookieOptions(production));
      res.clearCookie(VERIFICATION_COOKIE, cookieOptions(production));
      res.status(201).json({ success: true, user: result.user, verificationRequired: false });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ success: false, message: "An account already exists with this email. Please sign in." }); return; }
      next(error);
    }
  });
  router.post("/login", limited(20), async (req, res, next) => {
    const parsed = login.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        message: "Enter a valid email and password.",
        errors: z.flattenError(parsed.error).fieldErrors,
      });
      return;
    }
    try {
      const denied = "The email or password is incorrect.";
      const user = await db.user.findUnique({
        where: { email: parsed.data.email },
      });
      const valid = await verifyPassword(
        parsed.data.password,
        user?.passwordHash ?? (await dummyHash),
      );
      if (!user || !valid) {
        res.status(401).json({
          success: false,
          message: denied,
        });
        return;
      }
      const session = newSession();
      const account = await db.$transaction(async (tx) => {
        const locked = await tx.user.updateMany({
          where: {
            id: user.id,
            passwordHash: user.passwordHash,
            authVersion: user.authVersion,
            emailVerifiedAt: user.emailVerifiedAt,
          },
          data: { updatedAt: services.clock() },
        });
        if (locked.count !== 1) return null;
        await removePreviousSession(req, user.id, tx);
        await tx.session.create({
          data: {
            tokenHash: session.tokenHash,
            userId: user.id,
            expiresAt: session.expiresAt,
            authVersion: user.authVersion,
          },
        });
        return tx.user.findUniqueOrThrow({
          where: { id: user.id },
          select: publicUser,
        });
      });
      if (!account) {
        res
          .status(401)
          .json({
            success: false,
            message: denied,
          });
        return;
      }
      setSession(res, session.token);
      res.clearCookie(VERIFICATION_COOKIE, cookieOptions(production));
      res.json({ success: true, user: account, verificationRequired: false });
    } catch (error) {
      next(error);
    }
  });
  router.get("/me", authenticate, async (req, res, next) => {
    try {
      const user = await db.user.findFirst({
        where: {
          id: req.auth!.userId,
          organizationId: req.auth!.organizationId,
        },
        select: publicUser,
      });
      if (!user) {
        res
          .status(401)
          .json({ success: false, message: "Please sign in to continue." });
        return;
      }
      res.json({ success: true, user });
    } catch (error) {
      next(error);
    }
  });
  router.post("/logout", async (req, res, next) => {
    try {
      const tokens = [readSessionToken(req), readSessionToken(req, VERIFICATION_COOKIE)].filter((token): token is string => !!token);
      if (tokens.length)
        await db.session.deleteMany({ where: { tokenHash: { in: tokens.map(hashToken) } } });
      res.clearCookie(SESSION_COOKIE, cookieOptions(production));
      res.clearCookie(VERIFICATION_COOKIE, cookieOptions(production));
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
