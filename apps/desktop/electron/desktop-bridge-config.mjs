import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

const CONFIG_VERSION = 1;
const CONFIG_FILE_NAME = "openwork-desktop-bridge.json";
const DEFAULT_RECONNECT_MIN_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 15_000;
const DEFAULT_SHELL_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_READ_BYTES = 256 * 1024;
const DEFAULT_MAX_STDOUT_BYTES = 256 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 128 * 1024;

function trim(value) {
  return String(value ?? "").trim();
}

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = trim(value).toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseInteger(value, fallback) {
  const numeric = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function splitList(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => trim(entry)).filter(Boolean);
  }
  return trim(value)
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function ensureTrailingSlashFree(value) {
  return trim(value).replace(/\/+$/, "");
}

function defaultAllowedRoots(homeDir = os.homedir()) {
  return [
    path.join(homeDir, "Downloads"),
    path.join(homeDir, "Desktop"),
    path.join(homeDir, "Documents"),
    path.join(homeDir, "Developer"),
  ];
}

function normalizeAllowedRoots(value, homeDir = os.homedir()) {
  const roots = splitList(value);
  return (roots.length > 0 ? roots : defaultAllowedRoots(homeDir))
    .map((entry) => expandHome(entry, homeDir))
    .map((entry) => path.resolve(entry))
    .filter((entry, index, list) => list.indexOf(entry) === index);
}

export function expandHome(value, homeDir = os.homedir()) {
  const raw = trim(value);
  if (!raw) return "";
  if (raw === "~") return homeDir;
  if (raw.startsWith("~/")) return path.join(homeDir, raw.slice(2));
  return raw;
}

export function desktopBridgeConfigPath(userDataDir) {
  return path.join(userDataDir, CONFIG_FILE_NAME);
}

export function defaultDesktopBridgeConfig(input = {}) {
  const homeDir = input.homeDir || os.homedir();
  const serverUrl = ensureTrailingSlashFree(input.serverUrl);
  const enrollmentToken = trim(input.enrollmentToken);
  return {
    version: CONFIG_VERSION,
    enabled: parseBoolean(input.enabled, Boolean(serverUrl && enrollmentToken)),
    serverUrl,
    websocketUrl: ensureTrailingSlashFree(input.websocketUrl),
    enrollmentToken,
    deviceId: trim(input.deviceId) || randomUUID(),
    deviceName: trim(input.deviceName) || os.hostname() || "OpenWork Desktop",
    allowedRoots: normalizeAllowedRoots(input.allowedRoots, homeDir),
    reconnect: {
      minDelayMs: parseInteger(input?.reconnect?.minDelayMs, DEFAULT_RECONNECT_MIN_DELAY_MS),
      maxDelayMs: parseInteger(input?.reconnect?.maxDelayMs, DEFAULT_RECONNECT_MAX_DELAY_MS),
    },
    limits: {
      maxReadBytes: parseInteger(input?.limits?.maxReadBytes, DEFAULT_MAX_READ_BYTES),
      maxStdoutBytes: parseInteger(input?.limits?.maxStdoutBytes, DEFAULT_MAX_STDOUT_BYTES),
      maxStderrBytes: parseInteger(input?.limits?.maxStderrBytes, DEFAULT_MAX_STDERR_BYTES),
      shellTimeoutMs: parseInteger(input?.limits?.shellTimeoutMs, DEFAULT_SHELL_TIMEOUT_MS),
    },
  };
}

export function normalizeDesktopBridgeConfig(input = {}, options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const merged = {
    ...input,
    serverUrl: trim(env.OPENWORK_DESKTOP_BRIDGE_SERVER_URL) || input.serverUrl,
    websocketUrl: trim(env.OPENWORK_DESKTOP_BRIDGE_WEBSOCKET_URL) || input.websocketUrl,
    enrollmentToken: trim(env.OPENWORK_DESKTOP_BRIDGE_ENROLLMENT_TOKEN) || input.enrollmentToken,
    enabled:
      trim(env.OPENWORK_DESKTOP_BRIDGE_ENABLED) !== ""
        ? parseBoolean(env.OPENWORK_DESKTOP_BRIDGE_ENABLED, false)
        : input.enabled,
    allowedRoots:
      trim(env.OPENWORK_DESKTOP_BRIDGE_ALLOWED_ROOTS) !== ""
        ? splitList(env.OPENWORK_DESKTOP_BRIDGE_ALLOWED_ROOTS)
        : input.allowedRoots,
  };
  const normalized = defaultDesktopBridgeConfig({ ...merged, homeDir });
  if (normalized.serverUrl && !/^https?:\/\//i.test(normalized.serverUrl)) {
    throw new Error("Desktop bridge serverUrl must start with http:// or https://");
  }
  if (normalized.websocketUrl && !/^wss?:\/\//i.test(normalized.websocketUrl)) {
    throw new Error("Desktop bridge websocketUrl must start with ws:// or wss://");
  }
  return normalized;
}

export function redactedDesktopBridgeConfig(config = {}) {
  return {
    ...config,
    enrollmentToken: config.enrollmentToken ? `${String(config.enrollmentToken).slice(0, 6)}…` : "",
  };
}

export async function readDesktopBridgeConfig(userDataDir, options = {}) {
  const filePath = desktopBridgeConfigPath(userDataDir);
  try {
    const raw = await readFile(filePath, "utf8");
    return normalizeDesktopBridgeConfig(JSON.parse(raw), options);
  } catch {
    return normalizeDesktopBridgeConfig({}, options);
  }
}

async function writeJsonFileAtomic(targetPath, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(tempPath, serialized, "utf8");
  await rename(tempPath, targetPath);
}

export async function writeDesktopBridgeConfig(userDataDir, config, options = {}) {
  const normalized = normalizeDesktopBridgeConfig(config, options);
  const filePath = desktopBridgeConfigPath(userDataDir);
  await writeJsonFileAtomic(filePath, normalized);
  return normalized;
}
