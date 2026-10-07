import type { IncomingMessage, ServerResponse } from "node:http";

import { capabilityTag, hashCapability, isCapability, newCapability } from "./caps.ts";
import type { Config } from "./config.ts";
import type { ApnsEnv, Platform, Store } from "./db.ts";
import { clientIp, header, HttpError, readJson, sendJson } from "./http.ts";
import { RateLimiter } from "./limits.ts";
import { alertFor, KINDS, PREVIEW_SHAPE, type Alert, type Kind, type SendResult } from "./notification.ts";

export interface Senders {
  ios?: (token: string, env: ApnsEnv, alert: Alert) => Promise<SendResult>;
  android?: (token: string, alert: Alert) => Promise<SendResult>;
}

const MAX_BODY = 8 * 1024;
const MINUTE = 60_000;

/** APNs tokens are 32 bytes of hex today and Apple has said they may grow. */
const TOKEN_SHAPE: Record<Platform, RegExp> = {
  ios: /^[0-9a-fA-F]{64,200}$/,
  android: /^[A-Za-z0-9_:.-]{32,4096}$/,
};

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

export function createHandler(config: Config, store: Store, senders: Senders, log: Logger, clock = Date.now) {
  const registrations = new RateLimiter(60 * MINUTE, config.limits.registrationsPerHourPerIp);
  const perDevice = new RateLimiter(MINUTE, config.limits.pushesPerMinutePerDevice);
  const perIp = new RateLimiter(MINUTE, config.limits.pushesPerMinutePerIp);

  function capFrom(req: IncomingMessage): string {
    const auth = header(req, "authorization") ?? "";
    const cap = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!isCapability(cap)) throw new HttpError(401, "missing_capability");
    return cap;
  }

  async function register(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
    const body = await readJson(req, MAX_BODY);
    const platform = body.platform;
    if (platform !== "ios" && platform !== "android") throw new HttpError(400, "bad_platform");
    if (typeof body.token !== "string" || !TOKEN_SHAPE[platform].test(body.token)) throw new HttpError(400, "bad_token");
    const env: ApnsEnv = body.env === "sandbox" ? "sandbox" : "production";
    if (!senders[platform]) throw new HttpError(503, `${platform}_unavailable`);
    if (!registrations.take(ip, clock())) throw new HttpError(429, "too_many_registrations");

    const cap = newCapability();
    store.add(hashCapability(cap), { platform, token: body.token, env }, clock());
    store.bump("registered", platform, "", clock());
    sendJson(res, 201, { capability: cap });
  }

  async function push(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
    const cap = capFrom(req);
    const body = await readJson(req, MAX_BODY);
    const kind = body.kind as Kind;
    if (!KINDS.includes(kind)) throw new HttpError(400, "bad_kind");
    const preview = body.preview;
    if (preview !== undefined && (typeof preview !== "string" || !PREVIEW_SHAPE.test(preview))) throw new HttpError(400, "bad_preview");

    const now = clock();
    if (!perIp.take(ip, now)) throw new HttpError(429, "too_many_pushes");
    const capHash = hashCapability(cap);
    const device = store.get(capHash);
    if (!device) throw new HttpError(404, "unknown_capability");
    if (!perDevice.take(capHash, now)) throw new HttpError(429, "too_many_pushes");

    const alert = alertFor(kind, capabilityTag(cap), preview as string | undefined);
    const result = device.platform === "ios"
      ? await senders.ios?.(device.token, device.env, alert)
      : await senders.android?.(device.token, alert);
    if (!result) throw new HttpError(503, `${device.platform}_unavailable`);

    if (result.ok) {
      store.touch(capHash, now);
      store.bump("sent", device.platform, kind, now);
      return sendJson(res, 202, { ok: true });
    }
    if (result.gone) {
      // Every server holding a capability for this phone learns it on its next push.
      store.removeToken(device.token);
      store.bump("gone", device.platform, "", now);
      log.info(`dropped a dead ${device.platform} token: ${result.reason}`);
      throw new HttpError(410, "gone");
    }
    store.bump("failed", device.platform, "", now);
    log.warn(`push failed: ${result.reason}`);
    throw new HttpError(502, "upstream_failed");
  }

  function unregister(req: IncomingMessage, res: ServerResponse): void {
    const removed = store.remove(hashCapability(capFrom(req)));
    sendJson(res, removed ? 204 : 404, removed ? undefined : { error: "unknown_capability" });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0];
    const ip = clientIp(req, config.trustProxy, config.trustedProxies);
    try {
      if (req.method === "GET" && path === "/healthz") return sendJson(res, 200, { ok: true, version: config.version });
      if (req.method === "POST" && path === "/v1/devices") return await register(req, res, ip);
      if (req.method === "POST" && path === "/v1/push") return await push(req, res, ip);
      if (req.method === "DELETE" && path === "/v1/push") return unregister(req, res);
      throw new HttpError(404, "not_found");
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.code });
      log.warn("request failed", err);
      sendJson(res, 500, { error: "internal" });
    }
  }

  function prune(now = clock()): void {
    for (const limiter of [registrations, perDevice, perIp]) limiter.prune(now);
  }

  return { handle, prune };
}

