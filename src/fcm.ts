import { createPrivateKey, sign, type KeyObject } from "node:crypto";

import type { FcmConfig } from "./config.ts";
import type { Alert, SendResult } from "./notification.ts";

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEND_ORIGIN = "https://fcm.googleapis.com";
const TIMEOUT_MS = 10_000;

export function fcmAssertion(config: FcmConfig, key: KeyObject, nowSec: number): string {
  const enc = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const claims = { iss: config.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600 };
  const body = `${enc({ alg: "RS256", typ: "JWT" })}.${enc(claims)}`;
  return `${body}.${sign("sha256", Buffer.from(body), key).toString("base64url")}`;
}

export function fcmMessage(deviceToken: string, alert: Alert): object {
  return {
    message: {
      token: deviceToken,
      notification: { title: alert.title, body: alert.body },
      android: { priority: "high", notification: { channel_id: "messages", sound: "default" } },
      data: { c: alert.tag, ...(alert.preview ? { p: alert.preview } : {}) },
    },
  };
}

interface FcmError {
  error?: { status?: string; message?: string; details?: { errorCode?: string }[] };
}

/** UNREGISTERED is a dead token. A malformed one comes back as INVALID_ARGUMENT naming the token. */
export function fcmTokenIsDead(status: number, body: FcmError): boolean {
  const codes = (body.error?.details ?? []).map((d) => d.errorCode);
  if (status === 404 || codes.includes("UNREGISTERED")) return true;
  return status === 400 && /registration token/i.test(body.error?.message ?? "");
}

export class FcmSender {
  readonly config: FcmConfig;
  readonly fetchImpl: typeof fetch;
  readonly tokenUrl: string;
  readonly sendOrigin: string;
  private key: KeyObject;
  private access: { value: string; expiresAt: number } | null = null;

  constructor(config: FcmConfig, fetchImpl: typeof fetch = fetch, tokenUrl = TOKEN_URL, sendOrigin = SEND_ORIGIN) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.tokenUrl = tokenUrl;
    this.sendOrigin = sendOrigin;
    this.key = createPrivateKey(config.privateKeyPem);
  }

  private async accessToken(now: number): Promise<string> {
    if (this.access && now < this.access.expiresAt - 60_000) return this.access.value;
    const res = await this.fetchImpl(this.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: fcmAssertion(this.config, this.key, Math.floor(now / 1000)),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`google token ${res.status}`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("google token response had no access_token");
    this.access = { value: body.access_token, expiresAt: now + (body.expires_in ?? 3600) * 1000 };
    return this.access.value;
  }

  async send(deviceToken: string, alert: Alert, now = Date.now()): Promise<SendResult> {
    try {
      const res = await this.fetchImpl(`${this.sendOrigin}/v1/projects/${this.config.projectId}/messages:send`, {
        method: "POST",
        headers: { authorization: `Bearer ${await this.accessToken(now)}`, "content-type": "application/json" },
        body: JSON.stringify(fcmMessage(deviceToken, alert)),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return { ok: true };
      // A rejected access token is dropped so the next send fetches a fresh one.
      if (res.status === 401) this.access = null;
      const body = (await res.json().catch(() => ({}))) as FcmError;
      return { ok: false, gone: fcmTokenIsDead(res.status, body), reason: `fcm ${res.status} ${body.error?.status ?? ""}`.trim() };
    } catch (err) {
      return { ok: false, gone: false, reason: `fcm: ${(err as Error).message}` };
    }
  }
}
