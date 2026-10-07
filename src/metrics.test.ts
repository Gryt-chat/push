import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createHandler } from "./app.ts";
import { loadConfig } from "./config.ts";
import { Store } from "./db.ts";
import { createMetricsHandler } from "./metrics.ts";
import type { SendResult } from "./notification.ts";

const IOS_TOKEN = "a".repeat(64);
const FCM_TOKEN = `fcm-${"b".repeat(60)}:APA91b`;
const quiet = { info() {}, warn() {} };

let api: Server;
let metrics: Server;
let base: string;
let metricsBase: string;
let store: Store;
let now: number;
let next: SendResult;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function register(platform: string, token: string): Promise<string> {
  const res = await fetch(`${base}/v1/devices`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ platform, token }) });
  assert.equal(res.status, 201);
  return ((await res.json()) as { capability: string }).capability;
}

function push(cap: string, kind: string) {
  return fetch(`${base}/v1/push`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cap}` },
    body: JSON.stringify({ kind }),
  });
}

describe("push metrics", () => {
  beforeEach(async () => {
    store = Store.open(":memory:");
    now = Date.parse("2026-10-06T23:30:00Z");
    next = { ok: true };
    const clock = () => now;
    const { handle } = createHandler(
      loadConfig({ PORT: "0" }),
      store,
      { ios: async () => next, android: async () => next },
      quiet,
      clock,
    );
    api = createServer((req, res) => void handle(req, res));
    metrics = createServer(createMetricsHandler(store, clock));
    base = await listen(api);
    metricsBase = await listen(metrics);
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => api.close(() => resolve()));
    await new Promise<void>((resolve) => metrics.close(() => resolve()));
  });

  it("counts what was sent per UTC day, platform and kind, and exposes all-time counters", async () => {
    const phone = await register("ios", IOS_TOKEN);
    const other = await register("android", FCM_TOKEN);
    assert.equal((await push(phone, "dm")).status, 202);
    now += 60 * 60_000; // past midnight UTC
    assert.equal((await push(phone, "dm")).status, 202);
    assert.equal((await push(phone, "mention")).status, 202);
    next = { ok: false, gone: true, reason: "test" };
    assert.equal((await push(other, "dm")).status, 410);

    const stats = (await (await fetch(`${metricsBase}/stats?days=2`)).json()) as {
      devices: Record<string, number>;
      daily: { day: string; event: string; platform: string; kind: string; n: number }[];
    };
    assert.deepEqual(stats.devices, { ios: 1, android: 0 });
    assert.deepEqual(
      stats.daily.map((d) => `${d.day} ${d.event} ${d.platform} ${d.kind} ${d.n}`),
      [
        "2026-10-06 registered android  1",
        "2026-10-06 registered ios  1",
        "2026-10-06 sent ios dm 1",
        "2026-10-07 gone android  1",
        "2026-10-07 sent ios dm 1",
        "2026-10-07 sent ios mention 1",
      ],
    );

    const text = await (await fetch(`${metricsBase}/metrics`)).text();
    assert.match(text, /^gryt_push_sent_total\{platform="ios",kind="dm"\} 2$/m);
    assert.match(text, /^gryt_push_sent_total\{platform="ios",kind="mention"\} 1$/m);
    assert.match(text, /^gryt_push_gone_total\{platform="android"\} 1$/m);
    assert.match(text, /^gryt_push_registrations_total\{platform="ios"\} 1$/m);
    assert.match(text, /^gryt_push_devices\{platform="ios"\} 1$/m);
  });

  it("holds nothing about a device: no token and no capability in either view", async () => {
    const cap = await register("ios", IOS_TOKEN);
    await push(cap, "dm");
    const both = (await (await fetch(`${metricsBase}/stats?days=3660`)).text()) + (await (await fetch(`${metricsBase}/metrics`)).text());
    assert.ok(!both.includes(IOS_TOKEN));
    assert.ok(!both.includes(cap));
  });
});
