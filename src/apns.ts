import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { connect, type ClientHttp2Session } from "node:http2";

import type { ApnsConfig } from "./config.ts";
import type { ApnsEnv } from "./db.ts";
import type { Alert, SendResult } from "./notification.ts";

const ORIGINS: Record<ApnsEnv, string> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};

/** Apple refuses a token older than an hour and throttles one renewed under twenty minutes. */
const TOKEN_TTL_MS = 45 * 60_000;
const TIMEOUT_MS = 10_000;

/** Apple's reasons that mean this device token will never work again. */
const DEAD = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"]);

export function apnsJwt(config: ApnsConfig, key: KeyObject, nowSec: number): string {
  const enc = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const body = `${enc({ alg: "ES256", kid: config.keyId })}.${enc({ iss: config.teamId, iat: nowSec })}`;
  const signature = sign("sha256", Buffer.from(body), { key, dsaEncoding: "ieee-p1363" });
  return `${body}.${signature.toString("base64url")}`;
}

export function apnsPayload(alert: Alert): string {
  return JSON.stringify({
    aps: {
      alert: { title: alert.title, body: alert.body },
      sound: "default",
      "thread-id": alert.tag,
    },
    c: alert.tag,
  });
}

export class ApnsSender {
  readonly config: ApnsConfig;
  readonly origins: Record<ApnsEnv, string>;
  private key: KeyObject;
  private jwt: { value: string; at: number } | null = null;
  private sessions = new Map<string, ClientHttp2Session>();

  constructor(config: ApnsConfig, origins: Record<ApnsEnv, string> = ORIGINS) {
    this.config = config;
    this.origins = origins;
    this.key = createPrivateKey(config.keyPem);
  }

  private token(now: number): string {
    if (!this.jwt || now - this.jwt.at > TOKEN_TTL_MS) {
      this.jwt = { value: apnsJwt(this.config, this.key, Math.floor(now / 1000)), at: now };
    }
    return this.jwt.value;
  }

  private session(origin: string): ClientHttp2Session {
    const existing = this.sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = connect(origin);
    session.on("error", () => this.sessions.delete(origin));
    session.on("close", () => this.sessions.delete(origin));
    // An idle connection should not keep the process from exiting.
    session.unref();
    this.sessions.set(origin, session);
    return session;
  }

  send(deviceToken: string, env: ApnsEnv, alert: Alert, now = Date.now()): Promise<SendResult> {
    const body = apnsPayload(alert);
    return new Promise((resolve) => {
      let req;
      try {
        req = this.session(this.origins[env]).request({
          ":method": "POST",
          ":path": `/3/device/${deviceToken}`,
          authorization: `bearer ${this.token(now)}`,
          "apns-topic": this.config.topic,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "content-type": "application/json",
        });
      } catch (err) {
        resolve({ ok: false, gone: false, reason: `apns connect: ${(err as Error).message}` });
        return;
      }

      let status = 0;
      let text = "";
      req.setTimeout(TIMEOUT_MS, () => req.close());
      req.on("response", (headers) => (status = Number(headers[":status"])));
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => (text += chunk));
      req.on("error", (err) => resolve({ ok: false, gone: false, reason: `apns: ${err.message}` }));
      req.on("close", () => {
        if (status === 200) return resolve({ ok: true });
        let reason = "";
        try {
          reason = (JSON.parse(text) as { reason?: string }).reason ?? "";
        } catch {
          /* An empty or odd body is still a failure with a status. */
        }
        resolve({ ok: false, gone: status === 410 || DEAD.has(reason), reason: `apns ${status || "timeout"} ${reason}`.trim() });
      });
      req.end(body);
    });
  }

  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}
