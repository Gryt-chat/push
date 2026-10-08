import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Platform = "ios" | "android";
export type ApnsEnv = "production" | "sandbox";

/** What the relay counts. Per day, platform and kind, and never per device. */
export type Event = "registered" | "sent" | "gone" | "failed";

export interface DailyCount {
  day: string;
  event: Event;
  platform: Platform;
  kind: string;
  n: number;
}

export interface Device {
  platform: Platform;
  token: string;
  env: ApnsEnv;
  /** An Android app that opens sealed previews itself, so it's sent data-only messages (GRYT-1698). */
  opens?: boolean;
}

/**
 * Keyed by a hash of the capability, never the capability itself. A copy of this
 * file then holds device tokens but nothing that can make one ring.
 */
export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        cap_hash     TEXT PRIMARY KEY,
        platform     TEXT NOT NULL,
        token        TEXT NOT NULL,
        env          TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      )
    `);
    // Added after the table shipped, so an existing push.db gets the column here.
    const columns = this.db.prepare("PRAGMA table_info(devices)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "opens")) this.db.exec("ALTER TABLE devices ADD COLUMN opens INTEGER NOT NULL DEFAULT 0");
    // Kept apart from devices, so the totals outlive every device that made them.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_counts (
        day      TEXT NOT NULL,
        event    TEXT NOT NULL,
        platform TEXT NOT NULL,
        kind     TEXT NOT NULL,
        n        INTEGER NOT NULL,
        PRIMARY KEY (day, event, platform, kind)
      )
    `);
  }

  static open(dataDir: string): Store {
    if (dataDir !== ":memory:" && !existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    return new Store(dataDir === ":memory:" ? ":memory:" : join(dataDir, "push.db"));
  }

  add(capHash: string, device: Device, now: number): void {
    this.db
      .prepare("INSERT INTO devices (cap_hash, platform, token, env, opens, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(capHash, device.platform, device.token, device.env, device.opens ? 1 : 0, now, now);
  }

  get(capHash: string): Device | null {
    const row = this.db.prepare("SELECT platform, token, env, opens FROM devices WHERE cap_hash = ?").get(capHash) as
      | { platform: Platform; token: string; env: ApnsEnv; opens: number }
      | undefined;
    return row ? { platform: row.platform, token: row.token, env: row.env, opens: row.opens === 1 } : null;
  }

  touch(capHash: string, now: number): void {
    this.db.prepare("UPDATE devices SET last_used_at = ? WHERE cap_hash = ?").run(now, capHash);
  }

  remove(capHash: string): boolean {
    return Number(this.db.prepare("DELETE FROM devices WHERE cap_hash = ?").run(capHash).changes) > 0;
  }

  /** The platform said the token is dead, so every capability pointing at it is too. */
  removeToken(token: string): number {
    return Number(this.db.prepare("DELETE FROM devices WHERE token = ?").run(token).changes);
  }

  pruneIdle(before: number): number {
    return Number(this.db.prepare("DELETE FROM devices WHERE last_used_at < ?").run(before).changes);
  }

  /** `kind` is the push kind for `sent`, and empty for the rest. Days are UTC. */
  bump(event: Event, platform: Platform, kind: string, now: number): void {
    this.db
      .prepare(
        "INSERT INTO daily_counts (day, event, platform, kind, n) VALUES (?, ?, ?, ?, 1) " +
          "ON CONFLICT (day, event, platform, kind) DO UPDATE SET n = n + 1",
      )
      .run(new Date(now).toISOString().slice(0, 10), event, platform, kind);
  }

  /** Every count since `fromDay` (YYYY-MM-DD), oldest first. */
  daily(fromDay: string): DailyCount[] {
    return this.db
      .prepare("SELECT day, event, platform, kind, n FROM daily_counts WHERE day >= ? ORDER BY day, event, platform, kind")
      .all(fromDay) as unknown as DailyCount[];
  }

  /** All-time sums, so a counter read from them never goes backwards across a restart. */
  totals(): Omit<DailyCount, "day">[] {
    return this.db
      .prepare("SELECT event, platform, kind, SUM(n) AS n FROM daily_counts GROUP BY event, platform, kind ORDER BY event, platform, kind")
      .all() as unknown as Omit<DailyCount, "day">[];
  }

  devicesByPlatform(): Record<Platform, number> {
    const out: Record<Platform, number> = { ios: 0, android: 0 };
    for (const row of this.db.prepare("SELECT platform, COUNT(*) AS n FROM devices GROUP BY platform").all() as { platform: Platform; n: number }[]) {
      out[row.platform] = Number(row.n);
    }
    return out;
  }

  count(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM devices").get() as { n: number }).n);
  }
}
