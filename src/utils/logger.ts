import { redactSecrets } from "../security/redact.js";

type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: Level = "info";

export function setLogLevel(level: Level): void {
  minLevel = level;
}

function safeExtra(extra: unknown): unknown {
  if (extra === undefined) return undefined;
  if (typeof extra === "string") return redactSecrets(extra);
  if (extra instanceof Error) {
    return redactSecrets(`${extra.name}: ${extra.message}`);
  }
  try {
    return redactSecrets(typeof extra === "object" ? JSON.stringify(extra) : String(extra));
  } catch {
    return "[unserializable]";
  }
}

function emit(level: Level, msg: string, extra?: unknown): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] ${level.toUpperCase()} ${redactSecrets(msg)}`;
  const safe = safeExtra(extra);
  if (safe !== undefined) {
    // eslint-disable-next-line no-console
    console[level === "debug" ? "log" : level](line, safe);
  } else {
    // eslint-disable-next-line no-console
    console[level === "debug" ? "log" : level](line);
  }
}

export const log = {
  debug: (m: string, e?: unknown) => emit("debug", m, e),
  info: (m: string, e?: unknown) => emit("info", m, e),
  warn: (m: string, e?: unknown) => emit("warn", m, e),
  error: (m: string, e?: unknown) => emit("error", m, e),
};
