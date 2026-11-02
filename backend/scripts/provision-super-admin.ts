import "dotenv/config";
import { emitKeypressEvents } from "node:readline";
import { PrismaClient } from "@prisma/client";
import { provisionSuperAdmin, resetSuperAdminPassword } from "../src/super-admin/provision";
import { ServiceError } from "../src/services/errors";

// Secrets are accepted only from a hidden interactive TTY, never argv/env/stdout.
function secret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Interactive terminal required for hidden password entry.");
  process.stdout.write(prompt); emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const done = () => { process.stdin.off("keypress", keypress); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write("\n"); };
    const keypress = (text: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean }) => {
      if (key.ctrl && key.name === "c") { done(); reject(new Error("Provisioning cancelled.")); }
      else if (key.name === "return") { done(); resolve(value); }
      else if (key.name === "backspace") value = value.slice(0, -1);
      else if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(text) && value.length < 129) value += text;
    };
    process.stdin.on("keypress", keypress);
  });
}
async function main() {
  const args = process.argv.slice(2), values = new Map<string, string>(), flags = new Set<string>();
  try {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (["--email", "--name", "--admin-id"].includes(arg) && args[i + 1] && !args[i + 1]!.startsWith("--") && !values.has(arg)) values.set(arg, args[++i]!);
      else if (["--initial-owner", "--additional-admin", "--reset-password", "--confirm-platform-access"].includes(arg) && !flags.has(arg)) flags.add(arg);
      else throw new Error("Invalid arguments.");
    }
    const modes = ["--initial-owner", "--additional-admin", "--reset-password"].filter((flag) => flags.has(flag));
    if (modes.length !== 1 || !flags.has("--confirm-platform-access")) throw new Error("Explicit mode and confirmation required.");
    const recovery = modes[0] === "--reset-password";
    if (recovery ? !values.has("--admin-id") || values.size !== 1 : !values.has("--email") || !values.has("--name") || values.size !== 2) throw new Error("Invalid arguments.");
    const password = await secret("New platform password (hidden, 8–128 characters): ");
    if (password !== await secret("Confirm password (hidden): ")) throw new Error("Passwords do not match. No account changed.");
    const db = new PrismaClient();
    try {
      const result = recovery ? await resetSuperAdminPassword(db, values.get("--admin-id")!, password, true)
        : await provisionSuperAdmin(db, { email: values.get("--email"), fullName: values.get("--name"), password, initialOwner: modes[0] === "--initial-owner", confirmed: true });
      console.log(JSON.stringify({ ...result, message: "Dedicated platform account updated. Sign in at /super-admin/login. Organization accounts were not changed." }));
    } finally { await db.$disconnect(); }
  } catch (error) {
    console.error(error instanceof ServiceError ? error.message : error instanceof Error && ["Interactive terminal required for hidden password entry.", "Provisioning cancelled.", "Passwords do not match. No account changed."].includes(error.message) ? error.message : "Provisioning refused or failed. Check arguments, database access and migrations; see SUPER_ADMIN.md.");
    process.exitCode = 1;
  }
}
void main();
