import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Creates a separate local database. Never migrates/resets the application's DB.
async function main() {
  const original = new URL(process.env.DATABASE_URL!);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1"].includes(original.hostname))
    throw new Error("Isolated verification requires a non-production localhost database.");
  const reuse = process.argv.includes("--reuse");
  const name = reuse ? JSON.parse(readFileSync(resolve("../artifacts/billing-audit-database.json"), "utf8")).database as string : `hrms_billing_audit_${randomBytes(6).toString("hex")}`;
  if (!/^hrms_billing_audit_[a-f0-9]{12}$/.test(name)) throw new Error("Invalid fixture database name.");
  const admin = new PrismaClient();
  try { if (!reuse) await admin.$executeRawUnsafe(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`); }
  finally { await admin.$disconnect(); }
  original.pathname = `/${name}`;
  const env = { ...process.env, DATABASE_URL: original.toString(), NODE_ENV: "test", RAZORPAY_MODE: "test",
    SMTP_HOST: "127.0.0.1", SMTP_PORT: "1", SMTP_USER: "", SMTP_PASS: "",
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require=${resolve("test/block-provider-network.cjs")}` };
  writeFileSync(resolve("../artifacts/billing-audit-database.json"), JSON.stringify({ database: name }));
  const run = (args: string[]) => {
    const child = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 600000, maxBuffer: 10 * 1024 * 1024 });
    if (args.includes("--test")) writeFileSync(resolve(process.argv.includes("--refunds") ? "../artifacts/refund-regression-tests.log" : "../artifacts/billing-audit-backend-tests.log"), `${child.stdout}\n${child.stderr}`);
    console.log(args.includes("--test") && child.status === 0 ? child.stdout.split("\n").filter((line) => /^ℹ /.test(line)).join("\n") : `${child.stdout}\n${child.stderr}`);
    if (child.status !== 0) throw new Error(`Isolated verification command failed (${child.status}): ${args.slice(0, 3).join(" ")}`);
  };
  run(["node_modules/prisma/build/index.js", "migrate", "deploy"]);
  run(["node_modules/prisma/build/index.js", "validate"]);
  run(["node_modules/prisma/build/index.js", "migrate", "status"]);
  run(["node_modules/prisma/build/index.js", "migrate", "diff", "--from-schema-datasource", "prisma/schema.prisma", "--to-schema-datamodel", "prisma/schema.prisma", "--exit-code"]);
  const suite = JSON.parse(readFileSync("package.json", "utf8")).scripts.test as string;
  run(process.argv.includes("--refunds")
    ? ["--import", "tsx", "--test", "--test-concurrency=1", "test/refunds.test.ts", "test/provider.test.ts", "test/refund-ui-errors.test.ts", "test/auth-redirects.test.ts"]
    : [...suite.replace(/^node /, "").split(" "), "test/billing-audit.test.ts", "test/shutdown.test.ts"]);
  console.log("Isolated billing verification passed. Fixture database retained only for browser verification.");
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
