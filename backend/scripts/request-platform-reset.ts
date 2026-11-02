import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { smtpMailer } from "../src/services/mail";
import { ServiceError } from "../src/services/errors";
import { SuperAdminRecoveryService } from "../src/super-admin/recovery";

// Exercises the actual recovery service. Never print a reset code or credentials.
async function main() {
  const email = z.string().trim().toLowerCase().max(254).email().parse(process.argv[2]);
  const db = new PrismaClient();
  try {
    const origin = new URL(process.env.FRONTEND_URL || "http://localhost:3000").origin;
    const recovery = new SuperAdminRecoveryService(db, smtpMailer(), origin, () => new Date());
    console.log(JSON.stringify({ success: true, ...await recovery.request(email) }));
  } catch (error) {
    console.error(JSON.stringify({ success: false, code: error instanceof ServiceError ? error.code : "RECOVERY_UNAVAILABLE", message: error instanceof ServiceError ? error.message : "Password recovery could not complete." }));
    process.exitCode = 1;
  } finally { await db.$disconnect(); }
}
void main();
