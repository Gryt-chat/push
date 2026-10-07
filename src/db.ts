import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Platform = "ios" | "android";
export type ApnsEnv = "production" | "sandbox";

export interface Device {
  platform: Platform;
  token: string;
  env: ApnsEnv;
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
  }

  static open(dataDir: string): Store {
    if (dataDir !== ":memory:" && !existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    return new Store(dataDir === ":memory:" ? ":memory:" : join(dataDir, "push.db"));
  }

  add(capHash: string, device: Device, now: number): void {
    this.db
      .prepare("INSERT INTO devices (cap_hash, platform, token, env, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(capHash, device.platform, device.token, device.env, now, now);
  }

  get(capHash: string): Device | null {
    const row = this.db.prepare("SELECT platform, token, env FROM devices WHERE cap_hash = ?").get(capHash) as
      | { platform: Platform; token: string; env: ApnsEnv }
      | undefined;
    return row ? { platform: row.platform, token: row.token, env: row.env } : null;
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

  count(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM devices").get() as { n: number }).n);
  }
}
