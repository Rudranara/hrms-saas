import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { hashPassword } from "./password";
import { hashToken, newSession, TRIAL_MS } from "./security";
import type { Mailer } from "../services/mail";
import { ServiceError, type Clock } from "../services/errors";

export const REGISTRATION_COOKIE = "hrms_registration";
const ttl = 10 * 60000;
const invalid = () => new ServiceError("REGISTRATION_OTP_INVALID", 400, "The code is incorrect or expired. Request a new code and try again.");
export class RegistrationService {
  constructor(private db: PrismaClient, private mailer: Mailer, private clock: Clock) {}
  private async deliver(email: string, code: string) {
    if (!this.mailer.available) throw new ServiceError("EMAIL_UNAVAILABLE", 503, "Registration email delivery is unavailable. Please try again later.");
    await this.mailer.send({ to: email, subject: "Verify your HRMS registration", text: `Your registration code is: ${code}\nIt expires in 10 minutes. Only the latest code works. If you did not request this, ignore this email.` });
  }
  async request(input: { organizationName: string; employeeSize: string; fullName: string; email: string; password: string; phoneNumber: string }, previousToken?: string | null) {
    if (!this.mailer.available) throw new ServiceError("EMAIL_UNAVAILABLE", 503, "Registration email delivery is unavailable. Please try again later.");
    const now = this.clock();
    if (await this.db.user.findUnique({ where: { email: input.email }, select: { id: true } })) throw new ServiceError("ACCOUNT_EXISTS", 409, "An account already exists with this email. Please sign in.");
    // Expired unfinished registrations never become users or organizations.
    await this.db.pendingRegistration.deleteMany({ where: { expiresAt: { lte: now } } });
    if (await this.db.pendingRegistration.count({ where: { email: input.email, createdAt: { gt: new Date(now.getTime() - 15 * 60000) } } }) >= 5) throw new ServiceError("EMAIL_RATE_LIMIT", 429, "Too many codes requested for this email. Please try again later.");
    const token = randomBytes(32).toString("hex"), code = String(randomInt(100000, 1000000));
    const row = await this.db.pendingRegistration.create({ data: { tokenHash: hashToken(token), organizationName: input.organizationName, employeeSize: input.employeeSize, fullName: input.fullName, phoneNumber: input.phoneNumber, email: input.email, passwordHash: await hashPassword(input.password), codeHash: hashToken(`${token}:${code}`), sentAt: now, expiresAt: new Date(now.getTime() + ttl) } });
    try { await this.deliver(input.email, code); }
    catch (error) { await this.db.pendingRegistration.deleteMany({ where: { id: row.id } }); throw error; }
    if (previousToken) await this.db.pendingRegistration.deleteMany({ where: { tokenHash: hashToken(previousToken), id: { not: row.id } } });
    return { token, email: row.email, expiresAt: row.expiresAt, resendAfter: 60 };
  }
  async resend(token: string) {
    const now = this.clock(), code = String(randomInt(100000, 1000000)), codeHash = hashToken(`${token}:${code}`);
    const result = await this.db.$transaction(async (tx) => {
      const row = await tx.pendingRegistration.findUnique({ where: { tokenHash: hashToken(token) } });
      if (!row || row.expiresAt <= now || row.createdAt.getTime() + 60 * 60000 <= now.getTime()) throw invalid();
      const changed = await tx.pendingRegistration.updateMany({ where: { id: row.id, sentAt: { lte: new Date(now.getTime() - 60000) } }, data: { codeHash, failedAttempts: 0, sentAt: now, expiresAt: new Date(now.getTime() + ttl) } });
      if (!changed.count) throw new ServiceError("OTP_COOLDOWN", 429, "Please wait one minute before resending the code.");
      return row;
    });
    try { await this.deliver(result.email, code); }
    catch (error) { await this.db.pendingRegistration.deleteMany({ where: { id: result.id, codeHash } }); throw error; }
    return { email: result.email, expiresAt: new Date(now.getTime() + ttl), resendAfter: 60 };
  }
  async verify(token: string, code: string) {
    const now = this.clock(), session = newSession();
    const result = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM PendingRegistration WHERE tokenHash = ${hashToken(token)} FOR UPDATE`;
      const row = await tx.pendingRegistration.findUnique({ where: { tokenHash: hashToken(token) } });
      if (!row || row.expiresAt <= now || row.failedAttempts >= 5) return null;
      if (!timingSafeEqual(Buffer.from(row.codeHash, "hex"), Buffer.from(hashToken(`${token}:${code}`), "hex"))) {
        await tx.pendingRegistration.update({ where: { id: row.id }, data: { failedAttempts: { increment: 1 } } });
        return null;
      }
      const organization = await tx.organization.create({ data: { name: row.organizationName, employeeSize: row.employeeSize, phoneNumber: row.phoneNumber, trialStartedAt: now, trialExpiresAt: new Date(now.getTime() + TRIAL_MS) } });
      const user = await tx.user.create({ data: { organizationId: organization.id, fullName: row.fullName, email: row.email, passwordHash: row.passwordHash, role: "ORGANIZATION_ADMIN", emailVerifiedAt: now }, select: { id: true, fullName: true, email: true, role: true, emailVerifiedAt: true, organizationId: true, organization: { select: { id: true, name: true, trialStartedAt: true, trialExpiresAt: true } } } });
      await tx.session.create({ data: { tokenHash: session.tokenHash, userId: user.id, expiresAt: session.expiresAt, authVersion: 0 } });
      await tx.pendingRegistration.delete({ where: { id: row.id } });
      return user;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    if (!result) throw invalid();
    return { user: result, token: session.token };
  }
}
