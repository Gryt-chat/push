import type { IncomingMessage, ServerResponse } from "node:http";

import type { Event, Store } from "./db.ts";

const DAY = 24 * 60 * 60_000;
const MAX_DAYS = 3660;

/** Prometheus text. The counters are sums of the daily table, so a restart doesn't reset them. */
export function renderMetrics(store: Store): string {
  const families: { event: Event; name: string; help: string }[] = [
    { event: "sent", name: "gryt_push_sent_total", help: "Notifications the platform accepted, by kind." },
    { event: "registered", name: "gryt_push_registrations_total", help: "Capabilities handed out." },
    { event: "gone", name: "gryt_push_gone_total", help: "Pushes the platform refused because the token is dead." },
    { event: "failed", name: "gryt_push_failed_total", help: "Pushes that failed for any other reason." },
  ];
  const totals = store.totals();
  // Each family's samples straight after its own HELP and TYPE, as the text format requires.
  const lines: string[] = [];
  for (const family of families) {
    lines.push(`# HELP ${family.name} ${family.help}`, `# TYPE ${family.name} counter`);
    for (const row of totals.filter((t) => t.event === family.event)) {
      const labels = row.event === "sent" ? `platform="${row.platform}",kind="${row.kind}"` : `platform="${row.platform}"`;
      lines.push(`${family.name}{${labels}} ${row.n}`);
    }
  }
  lines.push("# HELP gryt_push_devices Capabilities the relay holds right now.", "# TYPE gryt_push_devices gauge");
  for (const [platform, n] of Object.entries(store.devicesByPlatform())) lines.push(`gryt_push_devices{platform="${platform}"} ${n}`);
  return `${lines.join("\n")}\n`;
}

/** GET /metrics for Prometheus, GET /stats?days=N for a quick look. Never on the public port. */
export function createMetricsHandler(store: Store, clock = Date.now) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://metrics");
    if (req.method === "GET" && url.pathname === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      res.end(renderMetrics(store));
      return;
    }
    if (req.method === "GET" && url.pathname === "/stats") {
      const days = Math.min(MAX_DAYS, Math.max(1, Number(url.searchParams.get("days")) || 30));
      const from = new Date(clock() - (days - 1) * DAY).toISOString().slice(0, 10);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ from, devices: store.devicesByPlatform(), daily: store.daily(from) }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  };
}
