import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Counted as bytes arrive, not from Content-Length, which is whatever the sender says. */
export async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  return new Promise((resolve, reject) => {
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        // Discarded rather than destroyed, so the 413 still reaches the sender.
        req.removeAllListeners("data");
        req.resume();
        reject(new HttpError(413, "body_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function readJson(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const raw = await readBody(req, maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "bad_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "bad_json");
  return parsed as Record<string, unknown>;
}

export function sendJson(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status, { "x-content-type-options": "nosniff" });
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(text);
}

export function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** ::ffff:192.0.2.1 and 192.0.2.1 are the same machine. */
export function normaliseIp(address: string): string {
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

/** Forwarding headers are believed only from a proxy that was named, or any when none was. */
export function clientIp(req: IncomingMessage, trustProxy: boolean, trustedProxies: string[]): string {
  const peer = normaliseIp(req.socket.remoteAddress || "unknown");
  if (!trustProxy || (trustedProxies.length > 0 && !trustedProxies.includes(peer))) return peer;
  const cf = header(req, "cf-connecting-ip");
  if (cf) return cf;
  const forwarded = header(req, "x-forwarded-for");
  const last = forwarded?.split(",").map((s) => s.trim()).filter(Boolean).pop();
  return last || peer;
}
