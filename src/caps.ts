import { createHash, randomBytes } from "node:crypto";

/** 32 random bytes. Whoever holds one can make one phone ring, and nothing else. */
export function newCapability(): string {
  return `p_${randomBytes(32).toString("base64url")}`;
}

const SHAPE = /^p_[A-Za-z0-9_-]{43}$/;

export function isCapability(value: unknown): value is string {
  return typeof value === "string" && SHAPE.test(value);
}

export function hashCapability(cap: string): string {
  return createHash("sha256").update(cap).digest("hex");
}

/** What a notification carries so the phone can tell which server sent it. */
export function capabilityTag(cap: string): string {
  return hashCapability(cap).slice(0, 16);
}
