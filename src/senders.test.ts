import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { createServer, type Http2Server, type IncomingHttpHeaders } from "node:http2";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import { ApnsSender } from "./apns.ts";
import { FcmSender, fcmTokenIsDead } from "./fcm.ts";
import { alertFor } from "./notification.ts";

const alert = alertFor("dm", "0123456789abcdef");

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

describe("APNs", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  let server: Http2Server;
  let origin: string;
  const seen: { headers: IncomingHttpHeaders; body: string }[] = [];
  let reply = { status: 200, body: "" };

  before(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ headers: req.headers, body });
        res.writeHead(reply.status);
        res.end(reply.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  const sender = () =>
    new ApnsSender({ keyPem, keyId: "KEY123", teamId: "8883W2XTQ8", topic: "chat.gryt.app" }, { production: origin, sandbox: origin });

  it("sends a signed alert to the device path", async () => {
    const apns = sender();
    assert.deepEqual(await apns.send("ab".repeat(32), "production", alert), { ok: true });
    apns.close();

    const { headers, body } = seen.at(-1)!;
    assert.equal(headers[":path"], `/3/device/${"ab".repeat(32)}`);
    assert.equal(headers["apns-topic"], "chat.gryt.app");
    assert.equal(headers["apns-push-type"], "alert");

    const [h, c, s] = String(headers.authorization).replace("bearer ", "").split(".");
    assert.deepEqual(decode(h), { alg: "ES256", kid: "KEY123" });
    assert.equal(decode(c).iss, "8883W2XTQ8");
    assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")));

    assert.deepEqual(JSON.parse(body), {
      aps: { alert: { title: "Gryt", body: "New direct message" }, sound: "default", "thread-id": "0123456789abcdef" },
      c: "0123456789abcdef",
    });
  });

  it("calls an unregistered token gone and a server error not", async () => {
    const apns = sender();
    reply = { status: 410, body: JSON.stringify({ reason: "Unregistered" }) };
    assert.deepEqual(await apns.send("ab".repeat(32), "production", alert), { ok: false, gone: true, reason: "apns 410 Unregistered" });
    reply = { status: 400, body: JSON.stringify({ reason: "BadDeviceToken" }) };
    assert.equal((await apns.send("ab".repeat(32), "production", alert) as { gone: boolean }).gone, true);
    reply = { status: 503, body: JSON.stringify({ reason: "ServiceUnavailable" }) };
    assert.equal((await apns.send("ab".repeat(32), "production", alert) as { gone: boolean }).gone, false);
    apns.close();
    reply = { status: 200, body: "" };
  });
});

describe("FCM", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const config = {
    projectId: "gryt-test",
    clientEmail: "push@gryt-test.iam.gserviceaccount.com",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };

  it("trades a signed assertion for a token, reuses it, and sends", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/token")) return Response.json({ access_token: "ya29.test", expires_in: 3600 });
      return Response.json({ name: "projects/gryt-test/messages/1" });
    }) as unknown as typeof fetch;

    const fcm = new FcmSender(config, fakeFetch, "https://google.test/token", "https://fcm.test");
    assert.deepEqual(await fcm.send("tok", alert, 1_000_000), { ok: true });
    assert.deepEqual(await fcm.send("tok", alert, 1_000_500), { ok: true });
    assert.equal(calls.filter((c) => c.url.endsWith("/token")).length, 1);

    const assertion = new URLSearchParams(String(calls[0].init.body)).get("assertion")!;
    const [h, c, s] = assertion.split(".");
    assert.equal(decode(h).alg, "RS256");
    assert.equal(decode(c).iss, config.clientEmail);
    assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, "base64url")));

    const send = calls[1];
    assert.equal(send.url, "https://fcm.test/v1/projects/gryt-test/messages:send");
    assert.equal((send.init.headers as Record<string, string>).authorization, "Bearer ya29.test");
    const message = JSON.parse(String(send.init.body)).message;
    assert.equal(message.token, "tok");
    assert.deepEqual(message.notification, { title: "Gryt", body: "New direct message" });
    assert.deepEqual(message.data, { c: "0123456789abcdef" });
  });

  it("knows a dead token from a failure", () => {
    assert.equal(fcmTokenIsDead(404, { error: { status: "NOT_FOUND" } }), true);
    assert.equal(fcmTokenIsDead(400, { error: { details: [{ errorCode: "UNREGISTERED" }] } }), true);
    assert.equal(fcmTokenIsDead(400, { error: { message: "The registration token is not a valid FCM registration token" } }), true);
    assert.equal(fcmTokenIsDead(400, { error: { message: "Invalid JSON payload" } }), false);
    assert.equal(fcmTokenIsDead(503, {}), false);
  });
});
