import type {
  OpenworkDesktopBridgeStatus,
  OpenworkServerClient,
} from "../../../../app/lib/openwork-server";
import { readOpenworkEnvPendingChanges } from "../../../../app/lib/openwork-env-runtime";

const DEFAULT_CACHE_KEY = "__openwork_env_default__";
const MAX_CONTEXT_CACHE_ENTRIES = 100;

const envSystemContextCache = new Map<string, string | undefined>();
const desktopBridgeContextCache = new Map<string, string | undefined>();

export function clearOpenworkEnvSystemContextCache(): void {
  envSystemContextCache.clear();
  desktopBridgeContextCache.clear();
}

function normalizeEnvKeys(keys: string[]): string[] {
  return Array.from(
    new Set(
      keys.flatMap((key) => {
        const trimmed = key.trim();
        return /^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed) ? [trimmed] : [];
      }),
    ),
  ).sort((a, b) => a.localeCompare(b));
}

export async function buildOpenworkEnvSystemContext(
  client: OpenworkServerClient | null,
  options: {
    cacheKey?: string;
    runtimeKey?: string | null;
    readPendingChanges?: () => boolean;
  } = {},
): Promise<string | undefined> {
  if (!client) return undefined;
  const readPendingChanges = options.readPendingChanges ??
    (() => readOpenworkEnvPendingChanges(options.runtimeKey));
  if (readPendingChanges()) return undefined;

  const cacheKey = `${client.baseUrl}:${options.cacheKey ?? DEFAULT_CACHE_KEY}`;
  if (envSystemContextCache.has(cacheKey)) {
    return envSystemContextCache.get(cacheKey);
  }

  try {
    const response = await client.listUserEnvKeys();
    const keys = normalizeEnvKeys(response.keys ?? []);
    if (keys.length === 0) {
      rememberEnvSystemContext(cacheKey, undefined);
      return undefined;
    }

    const keyList = keys.map((key) => `- ${key}`).join("\n");

    const context = [
      "OpenWork environment variables configured:",
      keyList,
      "Only names are shown; values are secret. Use these names when relevant.",
    ].join("\n");
    rememberEnvSystemContext(cacheKey, context);
    return context;
  } catch {
    return undefined;
  }
}

function rememberEnvSystemContext(cacheKey: string, context: string | undefined): void {
  if (envSystemContextCache.size >= MAX_CONTEXT_CACHE_ENTRIES && !envSystemContextCache.has(cacheKey)) {
    const firstKey = envSystemContextCache.keys().next().value;
    if (firstKey) envSystemContextCache.delete(firstKey);
  }
  envSystemContextCache.set(cacheKey, context);
}

function rememberDesktopBridgeContext(cacheKey: string, context: string | undefined): void {
  if (desktopBridgeContextCache.size >= MAX_CONTEXT_CACHE_ENTRIES && !desktopBridgeContextCache.has(cacheKey)) {
    const firstKey = desktopBridgeContextCache.keys().next().value;
    if (firstKey) desktopBridgeContextCache.delete(firstKey);
  }
  desktopBridgeContextCache.set(cacheKey, context);
}

function buildDesktopBridgeContextFromStatus(status: OpenworkDesktopBridgeStatus): string | undefined {
  if (!status.connected || !status.device) return undefined;
  const toolNames = Array.from(
    new Set(
      (status.device.tools ?? []).flatMap((tool) => {
        const name = tool.name?.trim() ?? "";
        return name ? [name] : [];
      }),
    ),
  );
  const toolList = toolNames.length > 0 ? toolNames.join(", ") : "local-fs-list, local-fs-read, local-shell-exec";
  const allowedRoots = Array.from(
    new Set(
      (status.device.allowedRoots ?? [])
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
  const allowedRootsLine = allowedRoots.length > 0
    ? `The approved local roots for this connected computer are: ${allowedRoots.join(", ")}. Use these exact paths instead of guessing the user's home directory.`
    : null;
  return [
    "A desktop bridge to the user's actual computer is connected for this workspace.",
    "When the user asks about their machine, home folder, Downloads, Desktop, Documents, local apps, or files on their laptop, use the desktop bridge tools instead of remote worker shell/file tools.",
    "Prefer these desktop bridge tools for user-machine access:",
    `- ${toolList}`,
    ...(allowedRootsLine ? [allowedRootsLine] : []),
    "The built-in remote bash/read tools operate inside the worker container, not on the user's computer.",
    "Only use remote worker tools for files that are clearly inside the remote workspace or container.",
  ].join("\n");
}

export async function buildDesktopBridgeSystemContext(
  client: OpenworkServerClient | null,
  workspaceId: string | null | undefined,
  options: {
    cacheKey?: string;
  } = {},
): Promise<string | undefined> {
  const normalizedWorkspaceId = workspaceId?.trim() ?? "";
  if (!client || !normalizedWorkspaceId) return undefined;
  const cacheKey = `${client.baseUrl}:${normalizedWorkspaceId}:${options.cacheKey ?? "__desktop_bridge_default__"}`;
  if (desktopBridgeContextCache.has(cacheKey)) {
    return desktopBridgeContextCache.get(cacheKey);
  }

  try {
    const status = await client.getDesktopBridgeStatus(normalizedWorkspaceId);
    const context = buildDesktopBridgeContextFromStatus(status);
    rememberDesktopBridgeContext(cacheKey, context);
    return context;
  } catch {
    return undefined;
  }
}
