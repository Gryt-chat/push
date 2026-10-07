import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createHandler, type Senders } from "./app.ts";
import { capabilityTag, hashCapability } from "./caps.ts";
import { loadConfig } from "./config.ts";
import { Store } from "./db.ts";
import type { Alert, SendResult } from "./notification.ts";

const IOS_TOKEN = "a".repeat(64);
const FCM_TOKEN = `fcm-${"b".repeat(60)}:APA91b`;
const quiet = { info() {}, warn() {} };

interface Sent {
  platform: string;
  token: string;
  env?: string;
  alert: Alert;
}

let server: Server;
let base: string;
let store: Store;
let sent: Sent[];
let next: SendResult;

async function start(env: Record<string, string> = {}, senders?: Senders) {
  store = Store.open(":memory:");
  sent = [];
  next = { ok: true };
  const config = loadConfig({ PORT: "0", ...env });
  const fake: Senders = senders ?? {
    ios: async (token, apnsEnv, alert) => (sent.push({ platform: "ios", token, env: apnsEnv, alert }), next),
    android: async (token, alert) => (sent.push({ platform: "android", token, alert }), next),
  };
  const { handle } = createHandler(config, store, fake, quiet);
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function post(path: string, body: unknown, cap?: string) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cap ? { authorization: `Bearer ${cap}` } : {}) },
    body: JSON.stringify(body),
  });
}

async function register(platform = "ios", token = IOS_TOKEN, env?: string): Promise<string> {
  const res = await post("/v1/devices", { platform, token, env });
  assert.equal(res.status, 201);
  return ((await res.json()) as { capability: string }).capability;
}

describe("push relay", () => {
  beforeEach(() => start());
  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("registers a device and pushes to it with fixed text", async () => {
    const cap = await register("ios", IOS_TOKEN, "sandbox");
    assert.match(cap, /^p_[A-Za-z0-9_-]{43}$/);

    const res = await post("/v1/push", { kind: "mention" }, cap);
    assert.equal(res.status, 202);
    assert.deepEqual(sent, [
      { platform: "ios", token: IOS_TOKEN, env: "sandbox", alert: { title: "Gryt", body: "Someone mentioned you", tag: capabilityTag(cap) } },
    ]);
  });

  it("stores a hash of the capability, never the capability", async () => {
    const cap = await register();
    const rows = store.db.prepare("SELECT * FROM devices").all() as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cap_hash, hashCapability(cap));
    assert.ok(!JSON.stringify(rows).includes(cap));
  });

  it("gives each registration its own capability for the same phone", async () => {
    const a = await register();
    const b = await register();
    assert.notEqual(a, b);
    assert.notEqual(capabilityTag(a), capabilityTag(b));
  });

  it("routes an android device to FCM", async () => {
    const cap = await register("android", FCM_TOKEN);
    assert.equal((await post("/v1/push", { kind: "dm" }, cap)).status, 202);
    assert.equal(sent[0].platform, "android");
    assert.equal(sent[0].alert.body, "New direct message");
  });

  it("refuses bad platforms, tokens and kinds", async () => {
    assert.equal((await post("/v1/devices", { platform: "web", token: IOS_TOKEN })).status, 400);
    assert.equal((await post("/v1/devices", { platform: "ios", token: "nothex" })).status, 400);
    assert.equal((await post("/v1/devices", { platform: "android", token: "short" })).status, 400);
    const cap = await register();
    assert.equal((await post("/v1/push", { kind: "<b>hi</b>" }, cap)).status, 400);
    assert.equal(sent.length, 0);
  });

  it("wants the capability in the header", async () => {
    assert.equal((await post("/v1/push", { kind: "dm" })).status, 401);
    assert.equal((await post("/v1/push", { kind: "dm" }, "p_short")).status, 401);
    assert.equal((await post("/v1/push", { kind: "dm" }, `p_${"x".repeat(43)}`)).status, 404);
  });

  it("drops every capability for a token the platform calls dead, and says 410", async () => {
    const a = await register();
    const b = await register();
    next = { ok: false, gone: true, reason: "apns 410 Unregistered" };
    assert.equal((await post("/v1/push", { kind: "dm" }, a)).status, 410);
    assert.equal(store.count(), 0);
    assert.equal((await post("/v1/push", { kind: "dm" }, b)).status, 404);
  });

  it("keeps the device when the platform only failed", async () => {
    const cap = await register();
    next = { ok: false, gone: false, reason: "apns 503" };
    assert.equal((await post("/v1/push", { kind: "dm" }, cap)).status, 502);
    assert.equal(store.count(), 1);
  });

  it("unregisters", async () => {
    const cap = await register();
    const del = () => fetch(`${base}/v1/push`, { method: "DELETE", headers: { authorization: `Bearer ${cap}` } });
    assert.equal((await del()).status, 204);
    assert.equal((await del()).status, 404);
  });

  it("refuses a body over the limit", async () => {
    const res = await post("/v1/devices", { platform: "ios", token: IOS_TOKEN, pad: "x".repeat(20_000) });
    assert.equal(res.status, 413);
  });
});

describe("limits", () => {
  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("caps pushes per device so a leaked capability cannot flood a phone", async () => {
    await start({ LIMIT_PUSHES_PER_MINUTE_PER_DEVICE: "2" });
    const cap = await register();
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await post("/v1/push", { kind: "message" }, cap)).status);
    assert.deepEqual(statuses, [202, 202, 429]);
    assert.equal(sent.length, 2);
  });

  it("caps registrations per address", async () => {
    await start({ LIMIT_REGISTRATIONS_PER_HOUR_PER_IP: "1" });
    await register();
    assert.equal((await post("/v1/devices", { platform: "ios", token: IOS_TOKEN })).status, 429);
  });

  it("refuses a platform with no credentials instead of pretending", async () => {
    await start({}, { android: async () => ({ ok: true }) });
    assert.equal((await post("/v1/devices", { platform: "ios", token: IOS_TOKEN })).status, 503);
  });
});
