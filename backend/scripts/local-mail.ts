import { SMTPServer } from "smtp-server";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
if (process.env.NODE_ENV === "production")
  throw new Error("Local mail inbox is development-only.");
const messages: { id: string; text: string; received: number }[] = [];
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ]!,
  );
const smtp = new SMTPServer({
  authOptional: true,
  disabledCommands: ["AUTH", "STARTTLS"],
  logger: false,
  size: 65536,
  onData(stream, _session, callback) {
    let text = "";
    stream.on("data", (chunk) => {
      if (text.length < 65536) text += chunk.toString();
    });
    stream.on("end", () => {
      messages.unshift({ id: randomUUID(), text, received: Date.now() });
      messages.splice(20);
      callback();
    });
  },
});
smtp.listen(1025, "127.0.0.1");
createServer((req, res) => {
  if (
    !["127.0.0.1:8025", "localhost:8025"].includes(req.headers.host || "") ||
    req.headers["sec-fetch-site"] === "cross-site"
  ) {
    res.writeHead(403).end();
    return;
  }
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  );
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const current = messages.filter((m) => Date.now() - m.received < 3600000);
  const id = new URL(req.url || "/", "http://127.0.0.1:8025").searchParams.get(
    "message",
  );
  const selected = current.find((m) => m.id === id);
  // SMTP messages may use quoted-printable encoding. Decode only for this local viewer.
  const text = selected?.text
    .replace(/=\r?\n/g, "")
    .replace(/=([A-F0-9]{2})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
  const links =
    text?.match(/https?:\/\/[^\s<>]+/g)?.filter((url) => {
      try {
        return ["localhost", "127.0.0.1"].includes(new URL(url).hostname);
      } catch {
        return false;
      }
    }) || [];
  res.end(
    `<html><head><title>HRMS local mail inbox</title><style>body{font:16px system-ui;max-width:950px;margin:40px auto;padding:20px;color:#1e293b}a{color:#4f46e5}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f4fb;padding:24px}</style></head><body><h1>Development mail inbox</h1><p>Loopback only. Messages stay in memory for up to one hour and disappear on restart. No email is delivered externally.</p>${selected ? `<p><a href="/">Back to inbox</a></p>${links.map((link) => `<p><a rel="noreferrer" href="${escape(link)}">Open local verification or recovery link</a></p>`).join("")}<pre>${escape(text || "")}</pre>` : current.map((m, i) => `<p><a href="/?message=${m.id}">Message ${i + 1} · ${new Date(m.received).toISOString()}</a></p>`).join("") || "<p>No messages received.</p>"}</body></html>`,
  );
}).listen(8025, "127.0.0.1", () =>
  console.log(
    "Local-only SMTP: 127.0.0.1:1025. Inbox: http://127.0.0.1:8025. Message bodies and tokens are never logged.",
  ),
);
