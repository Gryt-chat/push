import { readFileSync } from "node:fs";

/** Everything read from the environment, resolved once at boot. */
export interface Config {
  host: string;
  port: number;
  /** Prometheus and daily totals. 0 leaves it off; never publish it. */
  metricsPort: number;
  dataDir: string;
  version: string;
  trustProxy: boolean;
  trustedProxies: string[];

  /** Absent when no key is configured: iOS pushes are then refused, not faked. */
  apns: ApnsConfig | null;
  fcm: FcmConfig | null;

  limits: {
    registrationsPerHourPerIp: number;
    pushesPerMinutePerDevice: number;
    pushesPerMinutePerIp: number;
  };
  /** A capability nobody has pushed to for this long is forgotten. */
  idleDays: number;
}

export interface ApnsConfig {
  keyPem: string;
  keyId: string;
  teamId: string;
  /** The app's bundle id. */
  topic: string;
}

export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  privateKeyPem: string;
}

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number, got "${raw}"`);
  return value;
}

/** A key given inline wins over a path, so a compose file can use either. */
function secret(env: Env, inline: string, path: string): string | null {
  if (env[inline]) return env[inline]!.replace(/\\n/g, "\n");
  if (env[path]) return readFileSync(env[path]!, "utf8");
  return null;
}

function apnsFrom(env: Env): ApnsConfig | null {
  const keyPem = secret(env, "APNS_KEY", "APNS_KEY_PATH");
  if (!keyPem) return null;
  const keyId = env.APNS_KEY_ID;
  const teamId = env.APNS_TEAM_ID;
  if (!keyId || !teamId) throw new Error("APNS_KEY is set, so APNS_KEY_ID and APNS_TEAM_ID are needed too");
  return { keyPem, keyId, teamId, topic: env.APNS_TOPIC || "chat.gryt.app" };
}

function fcmFrom(env: Env): FcmConfig | null {
  const raw = secret(env, "FCM_SERVICE_ACCOUNT", "FCM_SERVICE_ACCOUNT_PATH");
  if (!raw) return null;
  const account = JSON.parse(raw) as { project_id?: string; client_email?: string; private_key?: string };
  if (!account.project_id || !account.client_email || !account.private_key) {
    throw new Error("FCM_SERVICE_ACCOUNT needs project_id, client_email and private_key");
  }
  return { projectId: account.project_id, clientEmail: account.client_email, privateKeyPem: account.private_key };
}

export function loadConfig(env: Env = process.env): Config {
  return {
    host: env.HOST || "0.0.0.0",
    port: int(env, "PORT", 8080),
    metricsPort: int(env, "METRICS_PORT", 0),
    dataDir: env.DATA_DIR || "./data",
    version: env.PUSH_VERSION || "dev",
    trustProxy: env.TRUST_PROXY === "true",
    trustedProxies: (env.TRUSTED_PROXIES || "").split(",").map((s) => s.trim()).filter(Boolean),
    apns: apnsFrom(env),
    fcm: fcmFrom(env),
    limits: {
      registrationsPerHourPerIp: int(env, "LIMIT_REGISTRATIONS_PER_HOUR_PER_IP", 60),
      pushesPerMinutePerDevice: int(env, "LIMIT_PUSHES_PER_MINUTE_PER_DEVICE", 20),
      pushesPerMinutePerIp: int(env, "LIMIT_PUSHES_PER_MINUTE_PER_IP", 1200),
    },
    idleDays: int(env, "IDLE_DAYS", 120),
  };
}
