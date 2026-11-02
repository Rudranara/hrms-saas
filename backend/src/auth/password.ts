import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// Node's maintained scrypt implementation; OWASP's N=2^16, r=8, p=2 profile.
const options = { N: 65536, r: 8, p: 2, maxmem: 96 * 1024 * 1024 };
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, options, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}
export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$65536$8$2$${salt.toString("hex")}$${key.toString("hex")}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, n, r, p, salt, hash] = encoded.split("$");
  if (
    algorithm !== "scrypt" ||
    n !== "65536" ||
    r !== "8" ||
    p !== "2" ||
    !/^[a-f0-9]{32}$/.test(salt ?? "") ||
    !/^[a-f0-9]{128}$/.test(hash ?? "")
  )
    return false;
  const key = await derive(password, Buffer.from(salt!, "hex"));
  return timingSafeEqual(key, Buffer.from(hash!, "hex"));
}
