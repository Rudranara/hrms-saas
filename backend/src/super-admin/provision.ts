import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { hashPassword } from "../auth/password";
import { ServiceError } from "../services/errors";

const inputSchema = z.strictObject({ email: z.string().trim().toLowerCase().max(254).email(), fullName: z.string().trim().min(2).max(120), password: z.string().min(8).max(128), initialOwner: z.boolean(), confirmed: z.literal(true) });
// Trusted local operator only. Never mount provisioning or recovery on HTTP routes.
export async function provisionSuperAdmin(db: PrismaClient, input: unknown) {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new ServiceError("INVALID_PROVISIONING", 400, "Provide a valid email/name, an 8–128 character password and explicit confirmation.");
  const data = parsed.data, passwordHash = await hashPassword(data.password);
  try {
    return await db.$transaction(async (tx) => {
      // SERIALIZABLE prevents two concurrent initial owners from both committing.
      const count = await tx.superAdmin.count();
      if (data.initialOwner && count !== 0) throw new ServiceError("BOOTSTRAP_CLOSED", 409, "A platform account already exists. Use the explicit additional-admin mode.");
      if (!data.initialOwner && count === 0) throw new ServiceError("OWNER_REQUIRED", 409, "Create the initial owner explicitly before additional administrators.");
      if (await tx.superAdmin.count({ where: { email: data.email } })) throw new ServiceError("EMAIL_UNAVAILABLE", 409, "A platform account already uses that email. No account changed.");
      const admin = await tx.superAdmin.create({ data: { email: data.email, fullName: data.fullName, passwordHash, emailVerifiedAt: null }, select: { id: true } });
      await tx.superAdminAuditEvent.create({ data: { actorSuperAdminId: admin.id, action: "ACCOUNT_PROVISIONED", outcome: "SUCCESS", reasonCode: data.initialOwner ? "INITIAL_OWNER_CLI" : "ADDITIONAL_ADMIN_CLI" } });
      return { id: admin.id, created: true };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code))
      throw new ServiceError("PROVISIONING_CONFLICT", 409, "Provisioning conflicted with another operation. Inspect platform accounts before retrying.");
    throw error;
  }
}
export async function resetSuperAdminPassword(db: PrismaClient, id: string, password: string, confirmed: boolean) {
  if (!confirmed || !/^[a-zA-Z0-9_-]{1,100}$/.test(id) || password.length < 8 || password.length > 128)
    throw new ServiceError("INVALID_RECOVERY", 400, "Supply the platform account ID, an 8–128 character password and explicit confirmation.");
  const passwordHash = await hashPassword(password);
  return db.$transaction(async (tx) => {
    const changed = await tx.superAdmin.updateMany({ where: { id, isActive: true }, data: { passwordHash, authVersion: { increment: 1 } } });
    if (!changed.count) throw new ServiceError("ACCOUNT_UNAVAILABLE", 404, "No active platform account matches that ID. No account changed.");
    await tx.superAdminSession.deleteMany({ where: { superAdminId: id } });
    await tx.superAdminEmailChange.updateMany({ where: { superAdminId: id, state: { in: ["SENT", "PENDING_DELIVERY"] } }, data: { state: "CANCELLED", consumedAt: new Date() } });
    await tx.superAdminAuditEvent.create({ data: { actorSuperAdminId: id, action: "PASSWORD_CHANGED", outcome: "SUCCESS", reasonCode: "TRUSTED_CLI_RECOVERY" } });
    return { id, recovered: true };
  });
}
