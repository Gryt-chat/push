import { createServer } from "node:http";

import { ApnsSender } from "./apns.ts";
import { createHandler, type Senders } from "./app.ts";
import { loadConfig } from "./config.ts";
import { Store } from "./db.ts";
import { FcmSender } from "./fcm.ts";

const DAY = 24 * 60 * 60_000;
const log = {
  info: (...args: unknown[]) => console.log(new Date().toISOString(), ...args),
  warn: (...args: unknown[]) => console.warn(new Date().toISOString(), ...args),
};

const config = loadConfig();
const store = Store.open(config.dataDir);

const senders: Senders = {};
const apns = config.apns ? new ApnsSender(config.apns) : null;
if (apns) senders.ios = (token, env, alert) => apns.send(token, env, alert);
if (config.fcm) {
  const fcm = new FcmSender(config.fcm);
  senders.android = (token, alert) => fcm.send(token, alert);
}

const { handle, prune } = createHandler(config, store, senders, log);

function housekeeping(): void {
  prune();
  const dropped = store.pruneIdle(Date.now() - config.idleDays * DAY);
  if (dropped > 0) log.info(`forgot ${dropped} idle devices`);
}
housekeeping();
const timer = setInterval(housekeeping, 10 * 60_000);
timer.unref();

const server = createServer((req, res) => void handle(req, res));
// Every body here is a few hundred bytes. A slow one is somebody holding a socket open.
server.requestTimeout = 10_000;
server.headersTimeout = 10_000;
server.listen(config.port, config.host, () => {
  const platforms = [apns && "ios", config.fcm && "android"].filter(Boolean).join(", ") || "none";
  log.info(`push ${config.version} on ${config.host}:${config.port}, platforms: ${platforms}, devices: ${store.count()}`);
});

function shutdown(): void {
  server.close();
  apns?.close();
  store.db.close();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
