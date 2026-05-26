import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

import { ApiError } from "./errors.js";
import type { Actor } from "./types.js";
import type { TokenService } from "./tokens.js";
import { hashToken, shortId } from "./utils.js";

const DEFAULT_ENROLL_TTL_MS = 60 * 60 * 1000;
const MAX_ENROLL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 30 * 1000;
const MAX_TOOL_CALL_TIMEOUT_MS = 10 * 60 * 1000;

type ToolCallStatus = "queued" | "sent" | "completed" | "failed";

type ServerMessage =
  | {
    type: "server_hello";
    protocolVersion: 1;
    connectionId: string;
    deviceId: string;
    serverTime: number;
  }
  | {
    type: "tool_call";
    callId: string;
    toolName: string;
    input: unknown;
    createdAt: number;
    timeoutMs: number;
  }
  | {
    type: "ack";
    ackType: "client_hello" | "capabilities_advertise" | "tool_result" | "tool_chunk" | "heartbeat";
    callId?: string;
    serverTime: number;
  }
  | {
    type: "error";
    code: string;
    message: string;
    callId?: string;
  };

export type DesktopEnrollmentTokenIssued = {
  id: string;
  token: string;
  label?: string;
  createdAt: number;
  expiresAt: number;
};

export type DesktopEnrollmentTokenView = {
  id: string;
  label?: string;
  createdAt: number;
  expiresAt: number;
  claimedAt: number | null;
  claimedByDeviceId: string | null;
  revokedAt: number | null;
};

export type DesktopAdvertisedTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
};

export type DesktopDeviceView = {
  id: string;
  enrollmentId: string;
  workspaceId?: string;
  name: string;
  platform?: string;
  arch?: string;
  clientVersion?: string;
  metadata: Record<string, unknown>;
  connected: boolean;
  connectedAt: number | null;
  lastSeenAt: number;
  enrolledAt: number;
  allowedRoots?: string[];
  tools: DesktopAdvertisedTool[];
};

export type DesktopToolCallView = {
  id: string;
  deviceId: string;
  toolName: string;
  input: unknown;
  status: ToolCallStatus;
  createdAt: number;
  updatedAt: number;
  timeoutMs: number;
  requestedBy: Actor | null;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  chunks: Array<{
    stream: string;
    chunk: unknown;
    timestamp: number;
  }>;
};

type DesktopEnrollmentTokenRecord = DesktopEnrollmentTokenView & {
  hash: string;
};

type DesktopDeviceRecord = {
  id: string;
  enrollmentId: string;
  tokenHash: string;
  workspaceId?: string;
  workspaceTokenHash?: string;
  name: string;
  platform?: string;
  arch?: string;
  clientVersion?: string;
  metadata: Record<string, unknown>;
  enrolledAt: number;
  lastSeenAt: number;
  allowedRoots: string[];
  tools: DesktopAdvertisedTool[];
  connection: DesktopConnectionRecord | null;
};

type DesktopConnectionRecord = {
  connectionId: string;
  connectedAt: number;
  lastSeenAt: number;
  send: (message: ServerMessage) => void;
};

type DesktopToolCallRecord = DesktopToolCallView;

type DeviceAuth = {
  deviceId: string;
  token: string;
};

function clampTtlMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_ENROLL_TTL_MS;
  const rounded = Math.trunc(value);
  if (rounded <= 0) return DEFAULT_ENROLL_TTL_MS;
  return Math.min(rounded, MAX_ENROLL_TTL_MS);
}

function clampToolCallTimeoutMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TOOL_CALL_TIMEOUT_MS;
  const rounded = Math.trunc(value);
  if (rounded <= 0) return DEFAULT_TOOL_CALL_TIMEOUT_MS;
  return Math.min(rounded, MAX_TOOL_CALL_TIMEOUT_MS);
}

function ensurePlainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readOptionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readRequiredTrimmedString(value: unknown, message: string): string {
  const trimmed = readOptionalTrimmedString(value);
  if (!trimmed) throw new ApiError(400, "invalid_request", message);
  return trimmed;
}

function sanitizeToolName(value: unknown): string {
  const name = readRequiredTrimmedString(value, "Tool name is required");
  if (!/^[A-Za-z0-9._:-]+$/.test(name)) {
    throw new ApiError(400, "invalid_tool_name", "Tool name contains unsupported characters");
  }
  return name;
}

function sanitizeToolDescriptor(value: unknown): DesktopAdvertisedTool | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const name = sanitizeToolName(record.name);
  const description = readOptionalTrimmedString(record.description);
  const annotations = ensurePlainObject(record.annotations);
  return {
    name,
    ...(description ? { description } : {}),
    ...(record.inputSchema === undefined ? {} : { inputSchema: record.inputSchema }),
    ...(Object.keys(annotations).length === 0 ? {} : { annotations }),
  };
}

function parseAdvertisedTools(input: unknown): DesktopAdvertisedTool[] {
  if (!Array.isArray(input)) {
    throw new ApiError(400, "invalid_request", "tools must be an array");
  }
  const tools: DesktopAdvertisedTool[] = [];
  for (const item of input.slice(0, 512)) {
    const tool = sanitizeToolDescriptor(item);
    if (!tool) continue;
    tools.push(tool);
  }
  return tools;
}

function parseAllowedRoots(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 64);
}

function headersToWebHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) result.append(key, item);
      continue;
    }
    result.set(key, value);
  }
  return result;
}

function buildUnauthorizedUpgradeResponse(message: string): Buffer {
  return Buffer.from(
    `HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(message)}\r\nConnection: close\r\n\r\n${message}`,
    "utf8",
  );
}

export class DesktopBridgeService {
  private enrollmentTokens = new Map<string, DesktopEnrollmentTokenRecord>();
  private enrollmentTokensByHash = new Map<string, DesktopEnrollmentTokenRecord>();
  private devices = new Map<string, DesktopDeviceRecord>();
  private deviceIdsByTokenHash = new Map<string, string>();
  private workspaceDeviceIdsByKey = new Map<string, string>();
  private toolCalls = new Map<string, DesktopToolCallRecord>();
  private toolCallWaiters = new Map<string, {
    resolve: (call: DesktopToolCallView) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  issueEnrollmentToken(input?: { label?: string; ttlMs?: number }): DesktopEnrollmentTokenIssued {
    const createdAt = Date.now();
    const id = shortId();
    const token = `owe_${shortId().replace(/-/g, "")}`;
    const record: DesktopEnrollmentTokenRecord = {
      id,
      hash: hashToken(token),
      label: readOptionalTrimmedString(input?.label),
      createdAt,
      expiresAt: createdAt + clampTtlMs(input?.ttlMs),
      claimedAt: null,
      claimedByDeviceId: null,
      revokedAt: null,
    };
    this.enrollmentTokens.set(record.id, record);
    this.enrollmentTokensByHash.set(record.hash, record);
    return {
      id: record.id,
      token,
      ...(record.label ? { label: record.label } : {}),
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    };
  }

  listEnrollmentTokens(): DesktopEnrollmentTokenView[] {
    return Array.from(this.enrollmentTokens.values())
      .map((record) => this.serializeEnrollmentToken(record))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  enrollDevice(input: {
    enrollmentToken: string;
    deviceName: string;
    platform?: string;
    arch?: string;
    clientVersion?: string;
    metadata?: unknown;
  }): { device: DesktopDeviceView; deviceToken: string } {
    const token = readRequiredTrimmedString(input.enrollmentToken, "Enrollment token is required");
    const record = this.enrollmentTokensByHash.get(hashToken(token));
    if (!record || record.revokedAt) {
      throw new ApiError(401, "invalid_enrollment_token", "Enrollment token is invalid");
    }
    const now = Date.now();
    if (record.expiresAt <= now) {
      throw new ApiError(401, "expired_enrollment_token", "Enrollment token has expired");
    }
    if (record.claimedByDeviceId) {
      throw new ApiError(409, "enrollment_token_claimed", "Enrollment token has already been used");
    }

    const deviceId = `dev_${shortId().replace(/-/g, "")}`;
    const deviceToken = `owd_${shortId().replace(/-/g, "")}`;
    const metadata = ensurePlainObject(input.metadata);
    const device: DesktopDeviceRecord = {
      id: deviceId,
      enrollmentId: record.id,
      tokenHash: hashToken(deviceToken),
      name: readRequiredTrimmedString(input.deviceName, "deviceName is required"),
      platform: readOptionalTrimmedString(input.platform),
      arch: readOptionalTrimmedString(input.arch),
      clientVersion: readOptionalTrimmedString(input.clientVersion),
      metadata,
      enrolledAt: now,
      lastSeenAt: now,
      allowedRoots: [],
      tools: [],
      connection: null,
    };

    this.devices.set(device.id, device);
    this.deviceIdsByTokenHash.set(device.tokenHash, device.id);
    record.claimedAt = now;
    record.claimedByDeviceId = device.id;

    return {
      device: this.serializeDevice(device),
      deviceToken,
    };
  }

  authenticateDeviceRequest(request: Pick<Request, "headers" | "url"> | { headers: IncomingHttpHeaders; url?: string | undefined }): {
    device: DesktopDeviceRecord;
  } {
    const headers = request.headers instanceof Headers ? request.headers : headersToWebHeaders(request.headers);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const auth = this.parseDeviceAuth(headers, url);
    return { device: this.authenticateDevice(auth) };
  }

  listDevices(): DesktopDeviceView[] {
    return Array.from(this.devices.values())
      .map((record) => this.serializeDevice(record))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  getDevice(deviceId: string): DesktopDeviceView {
    const device = this.devices.get(deviceId);
    if (!device) {
      throw new ApiError(404, "device_not_found", "Desktop device not found");
    }
    return this.serializeDevice(device);
  }

  connectWorkspaceDevice(input: {
    workspaceId: string;
    actor: Actor;
    deviceId: string;
    deviceName: string;
    platform?: string;
    arch?: string;
    clientVersion?: string;
    metadata?: unknown;
    send: (message: ServerMessage) => void;
  }): { device: DesktopDeviceView; connectionId: string; queuedCalls: DesktopToolCallView[] } {
    const workspaceId = readRequiredTrimmedString(input.workspaceId, "workspaceId is required");
    const workspaceTokenHash = readRequiredTrimmedString(input.actor?.tokenHash, "workspace bridge token is required");
    const clientDeviceId = readRequiredTrimmedString(input.deviceId, "deviceId is required");
    const deviceKey = `${workspaceId}::${workspaceTokenHash}::${clientDeviceId}`;
    const existingId = this.workspaceDeviceIdsByKey.get(deviceKey);
    const now = Date.now();
    const metadata = ensurePlainObject(input.metadata);

    let device = existingId ? this.devices.get(existingId) ?? null : null;
    if (!device) {
      device = {
        id: `dev_${shortId().replace(/-/g, "")}`,
        enrollmentId: `workspace:${workspaceId}`,
        tokenHash: workspaceTokenHash,
        workspaceId,
        workspaceTokenHash,
        name: readRequiredTrimmedString(input.deviceName, "deviceName is required"),
        platform: readOptionalTrimmedString(input.platform),
        arch: readOptionalTrimmedString(input.arch),
        clientVersion: readOptionalTrimmedString(input.clientVersion),
        metadata: {
          ...metadata,
          workspaceBridge: true,
          workspaceId,
          clientDeviceId,
        },
        enrolledAt: now,
        lastSeenAt: now,
        allowedRoots: [],
        tools: [],
        connection: null,
      };
      this.devices.set(device.id, device);
      this.workspaceDeviceIdsByKey.set(deviceKey, device.id);
    } else {
      device.workspaceId = workspaceId;
      device.workspaceTokenHash = workspaceTokenHash;
      device.name = readRequiredTrimmedString(input.deviceName, "deviceName is required");
      device.platform = readOptionalTrimmedString(input.platform) ?? device.platform;
      device.arch = readOptionalTrimmedString(input.arch) ?? device.arch;
      device.clientVersion = readOptionalTrimmedString(input.clientVersion) ?? device.clientVersion;
      device.metadata = {
        ...device.metadata,
        ...metadata,
        workspaceBridge: true,
        workspaceId,
        clientDeviceId,
      };
      device.lastSeenAt = now;
    }

    if (!device) {
      throw new ApiError(500, "device_not_initialized", "Desktop device failed to initialize");
    }

    const connected = this.connectDevice(device.id, input.send);
    return {
      device: this.serializeDevice(device),
      connectionId: connected.connectionId,
      queuedCalls: connected.queuedCalls,
    };
  }

  connectDevice(
    deviceId: string,
    send: (message: ServerMessage) => void,
  ): { connectionId: string; queuedCalls: DesktopToolCallView[] } {
    const device = this.devices.get(deviceId);
    if (!device) {
      throw new ApiError(404, "device_not_found", "Desktop device not found");
    }
    const now = Date.now();
    const connectionId = shortId();
    device.connection = {
      connectionId,
      send,
      connectedAt: now,
      lastSeenAt: now,
    };
    device.lastSeenAt = now;
    const queuedCalls = Array.from(this.toolCalls.values())
      .filter((call) => call.deviceId === deviceId && call.status === "queued")
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const call of queuedCalls) {
      this.dispatchToolCall(device, call);
    }
    return { connectionId, queuedCalls: queuedCalls.map((call) => ({ ...call })) };
  }

  disconnectDevice(deviceId: string, connectionId: string): void {
    const device = this.devices.get(deviceId);
    if (!device?.connection) return;
    if (device.connection.connectionId !== connectionId) return;
    device.connection = null;
    device.lastSeenAt = Date.now();
  }

  acceptClientHello(deviceId: string, connectionId: string): void {
    const device = this.requireConnectedDevice(deviceId, connectionId);
    const now = Date.now();
    device.lastSeenAt = now;
    if (device.connection) device.connection.lastSeenAt = now;
  }

  heartbeat(deviceId: string, connectionId: string): void {
    this.acceptClientHello(deviceId, connectionId);
  }

  advertiseTools(deviceId: string, connectionId: string, tools: unknown, allowedRoots?: unknown): DesktopDeviceView {
    const device = this.requireConnectedDevice(deviceId, connectionId);
    device.tools = parseAdvertisedTools(tools);
    device.allowedRoots = parseAllowedRoots(allowedRoots);
    const now = Date.now();
    device.lastSeenAt = now;
    if (device.connection) device.connection.lastSeenAt = now;
    return this.serializeDevice(device);
  }

  createToolCall(input: {
    deviceId: string;
    toolName: string;
    arguments: unknown;
    timeoutMs?: number;
    requestedBy?: Actor | null;
  }): DesktopToolCallView {
    const device = this.devices.get(input.deviceId);
    if (!device) {
      throw new ApiError(404, "device_not_found", "Desktop device not found");
    }
    const now = Date.now();
    const call: DesktopToolCallRecord = {
      id: `dtc_${shortId().replace(/-/g, "")}`,
      deviceId: device.id,
      toolName: sanitizeToolName(input.toolName),
      input: input.arguments,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      timeoutMs: clampToolCallTimeoutMs(input.timeoutMs),
      requestedBy: input.requestedBy ?? null,
      chunks: [],
    };
    this.toolCalls.set(call.id, call);
    this.dispatchToolCall(device, call);
    return { ...call };
  }

  getToolCall(callId: string): DesktopToolCallView {
    const call = this.toolCalls.get(callId);
    if (!call) {
      throw new ApiError(404, "tool_call_not_found", "Desktop tool call not found");
    }
    return { ...call };
  }

  listToolCalls(deviceId?: string): DesktopToolCallView[] {
    return Array.from(this.toolCalls.values())
      .filter((call) => (deviceId ? call.deviceId === deviceId : true))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((call) => ({ ...call }));
  }

  getActiveWorkspaceDevice(workspaceId: string): DesktopDeviceView | null {
    const record = Array.from(this.devices.values())
      .filter((device) => device.workspaceId === workspaceId && device.connection)
      .sort((a, b) => (b.connection?.lastSeenAt ?? b.lastSeenAt) - (a.connection?.lastSeenAt ?? a.lastSeenAt))[0];
    return record ? this.serializeDevice(record) : null;
  }

  async callWorkspaceTool(input: {
    workspaceId: string;
    toolName: string;
    arguments: unknown;
    timeoutMs?: number;
    requestedBy?: Actor | null;
  }): Promise<{ device: DesktopDeviceView; item: DesktopToolCallView }> {
    const workspaceId = readRequiredTrimmedString(input.workspaceId, "workspaceId is required");
    const device = Array.from(this.devices.values())
      .filter((entry) => entry.workspaceId === workspaceId && entry.connection)
      .sort((a, b) => (b.connection?.lastSeenAt ?? b.lastSeenAt) - (a.connection?.lastSeenAt ?? a.lastSeenAt))[0];
    if (!device) {
      throw new ApiError(409, "desktop_not_connected", "No desktop bridge is connected for this workspace");
    }
    const item = this.createToolCall({
      deviceId: device.id,
      toolName: input.toolName,
      arguments: input.arguments,
      timeoutMs: input.timeoutMs,
      requestedBy: input.requestedBy ?? null,
    });
    try {
      return {
        device: this.serializeDevice(device),
        item: await this.waitForToolCall(item.id, item.timeoutMs),
      };
    } catch (error) {
      const errorCode = (error as { code?: unknown } | null)?.code;
      const code = typeof errorCode === "string" ? errorCode : "desktop_tool_failed";
      const status = code === "tool_call_timeout" ? 504 : 502;
      throw new ApiError(status, code, error instanceof Error ? error.message : String(error));
    }
  }

  appendToolChunk(
    deviceId: string,
    connectionId: string,
    callId: string,
    input: { stream: string; chunk: unknown },
  ): DesktopToolCallView {
    this.requireConnectedDevice(deviceId, connectionId);
    const call = this.requireToolCallForDevice(deviceId, callId);
    call.chunks.push({
      stream: readRequiredTrimmedString(input.stream, "stream is required"),
      chunk: input.chunk,
      timestamp: Date.now(),
    });
    call.updatedAt = Date.now();
    return { ...call };
  }

  appendToolChunkFromDevice(
    deviceId: string,
    callId: string,
    input: { stream: string; chunk: unknown },
  ): DesktopToolCallView {
    const call = this.requireToolCallForDevice(deviceId, callId);
    call.chunks.push({
      stream: readRequiredTrimmedString(input.stream, "stream is required"),
      chunk: input.chunk,
      timestamp: Date.now(),
    });
    call.updatedAt = Date.now();
    return { ...call };
  }

  completeToolCall(
    deviceId: string,
    connectionId: string,
    callId: string,
    input: { ok?: boolean; output?: unknown; error?: unknown },
  ): DesktopToolCallView {
    this.requireConnectedDevice(deviceId, connectionId);
    const call = this.requireToolCallForDevice(deviceId, callId);
    const now = Date.now();
    call.updatedAt = now;
    if (input.ok === false || input.error) {
      const errorRecord = ensurePlainObject(input.error);
      call.status = "failed";
      call.error = {
        code: readOptionalTrimmedString(errorRecord.code) ?? "tool_failed",
        message: readOptionalTrimmedString(errorRecord.message) ?? "Desktop tool call failed",
        ...(errorRecord.details === undefined ? {} : { details: errorRecord.details }),
      };
      delete call.result;
    } else {
      call.status = "completed";
      call.result = input.output;
      delete call.error;
    }
    this.finishToolCall(call);
    return { ...call };
  }

  completeToolCallFromDevice(
    deviceId: string,
    callId: string,
    input: { ok?: boolean; output?: unknown; error?: unknown },
  ): DesktopToolCallView {
    const call = this.requireToolCallForDevice(deviceId, callId);
    const now = Date.now();
    call.updatedAt = now;
    if (input.ok === false || input.error) {
      const errorRecord = ensurePlainObject(input.error);
      call.status = "failed";
      call.error = {
        code: readOptionalTrimmedString(errorRecord.code) ?? "tool_failed",
        message: readOptionalTrimmedString(errorRecord.message) ?? "Desktop tool call failed",
        ...(errorRecord.details === undefined ? {} : { details: errorRecord.details }),
      };
      delete call.result;
    } else {
      call.status = "completed";
      call.result = input.output;
      delete call.error;
    }
    this.finishToolCall(call);
    return { ...call };
  }

  buildWebSocketUrl(requestUrl: URL, deviceId: string, deviceToken: string): string {
    const protocol = requestUrl.protocol === "https:" ? "wss:" : "ws:";
    const target = new URL(`${protocol}//${requestUrl.host}/desktop/bridge`);
    target.searchParams.set("device_id", deviceId);
    target.searchParams.set("device_token", deviceToken);
    return target.toString();
  }

  private serializeEnrollmentToken(record: DesktopEnrollmentTokenRecord): DesktopEnrollmentTokenView {
    return {
      id: record.id,
      ...(record.label ? { label: record.label } : {}),
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      claimedAt: record.claimedAt,
      claimedByDeviceId: record.claimedByDeviceId,
      revokedAt: record.revokedAt,
    };
  }

  private serializeDevice(device: DesktopDeviceRecord): DesktopDeviceView {
    return {
      id: device.id,
      enrollmentId: device.enrollmentId,
      name: device.name,
      ...(device.workspaceId ? { workspaceId: device.workspaceId } : {}),
      ...(device.platform ? { platform: device.platform } : {}),
      ...(device.arch ? { arch: device.arch } : {}),
      ...(device.clientVersion ? { clientVersion: device.clientVersion } : {}),
      metadata: device.metadata,
      connected: Boolean(device.connection),
      connectedAt: device.connection?.connectedAt ?? null,
      lastSeenAt: device.connection?.lastSeenAt ?? device.lastSeenAt,
      enrolledAt: device.enrolledAt,
      ...(device.allowedRoots.length > 0 ? { allowedRoots: [...device.allowedRoots] } : {}),
      tools: device.tools,
    };
  }

  private parseDeviceAuth(headers: Headers, url: URL): DeviceAuth {
    const bearerHeader = headers.get("authorization") ?? "";
    const bearerMatch = bearerHeader.match(/^Bearer\s+(.+)$/i);
    const queryToken = readOptionalTrimmedString(url.searchParams.get("device_token"));
    const token = bearerMatch?.[1]?.trim() || queryToken;
    if (!token) {
      throw new ApiError(401, "unauthorized", "Missing device token");
    }
    const deviceId =
      readOptionalTrimmedString(headers.get("x-openwork-device-id"))
      ?? readOptionalTrimmedString(url.searchParams.get("device_id"));
    if (!deviceId) {
      throw new ApiError(401, "unauthorized", "Missing device id");
    }
    return { deviceId, token };
  }

  private authenticateDevice(auth: DeviceAuth): DesktopDeviceRecord {
    const device = this.devices.get(auth.deviceId);
    if (!device) {
      throw new ApiError(401, "unauthorized", "Invalid device credentials");
    }
    if (hashToken(auth.token) !== device.tokenHash) {
      throw new ApiError(401, "unauthorized", "Invalid device credentials");
    }
    device.lastSeenAt = Date.now();
    return device;
  }

  private requireConnectedDevice(deviceId: string, connectionId: string): DesktopDeviceRecord {
    const device = this.devices.get(deviceId);
    if (!device) {
      throw new ApiError(404, "device_not_found", "Desktop device not found");
    }
    if (!device.connection || device.connection.connectionId !== connectionId) {
      throw new ApiError(409, "device_not_connected", "Desktop device is not connected");
    }
    return device;
  }

  private requireToolCallForDevice(deviceId: string, callId: string): DesktopToolCallRecord {
    const call = this.toolCalls.get(callId);
    if (!call || call.deviceId !== deviceId) {
      throw new ApiError(404, "tool_call_not_found", "Desktop tool call not found");
    }
    return call;
  }

  private dispatchToolCall(device: DesktopDeviceRecord, call: DesktopToolCallRecord): void {
    if (!device.connection) return;
    call.status = "sent";
    call.updatedAt = Date.now();
    device.connection.send({
      type: "tool_call",
      callId: call.id,
      toolName: call.toolName,
      input: call.input,
      createdAt: call.createdAt,
      timeoutMs: call.timeoutMs,
    });
  }

  private waitForToolCall(callId: string, timeoutMs: number): Promise<DesktopToolCallView> {
    const existing = this.toolCalls.get(callId);
    if (!existing) {
      return Promise.reject(new ApiError(404, "tool_call_not_found", "Desktop tool call not found"));
    }
    if (existing.status === "completed" || existing.status === "failed") {
      return Promise.resolve({ ...existing });
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const call = this.toolCalls.get(callId);
        if (!call || call.status === "completed" || call.status === "failed") return;
        call.status = "failed";
        call.updatedAt = Date.now();
        call.error = {
          code: "tool_call_timeout",
          message: `Desktop tool call timed out after ${timeoutMs}ms`,
        };
        delete call.result;
        this.finishToolCall(call);
      }, Math.max(1_000, timeoutMs));
      this.toolCallWaiters.set(callId, { resolve, reject, timer });
    });
  }

  private finishToolCall(call: DesktopToolCallRecord): void {
    const waiter = this.toolCallWaiters.get(call.id);
    if (!waiter) return;
    this.toolCallWaiters.delete(call.id);
    clearTimeout(waiter.timer);
    if (call.status === "failed" && call.error) {
      const error = new Error(call.error.message) as Error & { code?: string; details?: unknown };
      error.code = call.error.code;
      error.details = call.error.details;
      waiter.reject(error);
      return;
    }
    waiter.resolve({ ...call });
  }
}

type BridgeSocketContext = {
  deviceId: string;
  connectionId: string;
};

type UpgradeAuth =
  | { mode: "device"; deviceId: string }
  | { mode: "workspace"; workspaceId: string; actor: Actor };

function sendSocketJson(ws: WebSocket, message: ServerMessage): void {
  ws.send(JSON.stringify(message));
}

function parseSocketJson(data: unknown): Record<string, unknown> {
  if (typeof data === "string") {
    return ensurePlainObject(JSON.parse(data));
  }
  if (data instanceof ArrayBuffer) {
    return ensurePlainObject(JSON.parse(Buffer.from(data).toString("utf8")));
  }
  if (Array.isArray(data)) {
    return ensurePlainObject(JSON.parse(Buffer.concat(data as Buffer[]).toString("utf8")));
  }
  if (Buffer.isBuffer(data)) {
    return ensurePlainObject(JSON.parse(data.toString("utf8")));
  }
  return {};
}

function parseBearerToken(headers: Headers): string {
  const header = headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

export function createDesktopBridgeUpgradeHandler(
  bridge: DesktopBridgeService,
  options?: { tokens?: TokenService },
) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WebSocket, _request: IncomingMessage, auth: UpgradeAuth) => {
    let context: BridgeSocketContext = { deviceId: "", connectionId: "" };
    if (auth.mode === "device") {
      const { connectionId } = bridge.connectDevice(auth.deviceId, (message) => sendSocketJson(ws, message));
      context = { deviceId: auth.deviceId, connectionId };

      sendSocketJson(ws, {
        type: "server_hello",
        protocolVersion: 1,
        connectionId,
        deviceId: auth.deviceId,
        serverTime: Date.now(),
      });
    }

    ws.on("message", (data: unknown) => {
      try {
        const payload = parseSocketJson(data);
        const type = readRequiredTrimmedString(payload.type, "message type is required");
        switch (type) {
          case "client_hello":
            if (auth.mode === "workspace" && !context.connectionId) {
              const deviceRecord = ensurePlainObject(payload.device);
              const connected = bridge.connectWorkspaceDevice({
                workspaceId: auth.workspaceId,
                actor: auth.actor,
                deviceId: readRequiredTrimmedString(deviceRecord.id ?? payload.deviceId, "device.id is required"),
                deviceName: readRequiredTrimmedString(deviceRecord.name ?? payload.deviceName, "device.name is required"),
                platform: readOptionalTrimmedString(deviceRecord.platform),
                arch: readOptionalTrimmedString(deviceRecord.arch),
                clientVersion: readOptionalTrimmedString(deviceRecord.clientVersion ?? deviceRecord.appVersion),
                metadata: deviceRecord,
                send: (message) => sendSocketJson(ws, message),
              });
              context = { deviceId: connected.device.id, connectionId: connected.connectionId };
              sendSocketJson(ws, {
                type: "server_hello",
                protocolVersion: 1,
                connectionId: connected.connectionId,
                deviceId: connected.device.id,
                serverTime: Date.now(),
              });
              sendSocketJson(ws, { type: "ack", ackType: "client_hello", serverTime: Date.now() });
              break;
            }
            bridge.acceptClientHello(context.deviceId, context.connectionId);
            sendSocketJson(ws, { type: "ack", ackType: "client_hello", serverTime: Date.now() });
            break;
          case "capabilities_advertise":
            bridge.advertiseTools(context.deviceId, context.connectionId, payload.tools, payload.allowedRoots);
            sendSocketJson(ws, { type: "ack", ackType: "capabilities_advertise", serverTime: Date.now() });
            break;
          case "tool_started":
            sendSocketJson(ws, {
              type: "ack",
              ackType: "tool_chunk",
              callId: readRequiredTrimmedString(payload.callId, "callId is required"),
              serverTime: Date.now(),
            });
            break;
          case "tool_stdout":
          case "tool_stderr":
          case "tool_chunk":
            bridge.appendToolChunk(context.deviceId, context.connectionId, readRequiredTrimmedString(payload.callId, "callId is required"), {
              stream:
                type === "tool_chunk"
                  ? readRequiredTrimmedString(payload.stream, "stream is required")
                  : type === "tool_stdout"
                    ? "stdout"
                    : "stderr",
              chunk: payload.chunk ?? payload.text ?? payload.data,
            });
            sendSocketJson(ws, {
              type: "ack",
              ackType: "tool_chunk",
              callId: readRequiredTrimmedString(payload.callId, "callId is required"),
              serverTime: Date.now(),
            });
            break;
          case "tool_result":
            bridge.completeToolCall(context.deviceId, context.connectionId, readRequiredTrimmedString(payload.callId, "callId is required"), {
              ok: typeof payload.ok === "boolean" ? payload.ok : true,
              output: payload.output ?? payload.result,
              error: payload.error,
            });
            sendSocketJson(ws, {
              type: "ack",
              ackType: "tool_result",
              callId: readRequiredTrimmedString(payload.callId, "callId is required"),
              serverTime: Date.now(),
            });
            break;
          case "heartbeat":
            bridge.heartbeat(context.deviceId, context.connectionId);
            sendSocketJson(ws, { type: "ack", ackType: "heartbeat", serverTime: Date.now() });
            break;
          case "client_error":
            sendSocketJson(ws, { type: "ack", ackType: "tool_chunk", serverTime: Date.now() });
            break;
          default:
            sendSocketJson(ws, { type: "error", code: "unsupported_message_type", message: `Unsupported message type: ${type}` });
            break;
        }
      } catch (error) {
        const apiError = error instanceof ApiError
          ? error
          : new ApiError(400, "invalid_message", "Invalid desktop bridge message");
        sendSocketJson(ws, { type: "error", code: apiError.code, message: apiError.message });
      }
    });

    ws.on("close", () => {
      bridge.disconnectDevice(context.deviceId, context.connectionId);
    });

    ws.on("error", () => {
      bridge.disconnectDevice(context.deviceId, context.connectionId);
    });
  });

  return (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const workspaceMatch = requestUrl.pathname.match(/^\/workspace\/([^/]+)\/desktop-bridge\/connect$/);
    if (requestUrl.pathname !== "/desktop/bridge" && requestUrl.pathname !== "/desktop-bridge/v1/connect" && !workspaceMatch) {
      return false;
    }
    if (workspaceMatch) {
      const tokens = options?.tokens;
      if (!tokens) {
        socket.write(buildUnauthorizedUpgradeResponse(JSON.stringify({ code: "desktop_bridge_unavailable", message: "Workspace desktop bridge authentication is unavailable" })));
        socket.destroy();
        return true;
      }
      const headers = headersToWebHeaders(request.headers);
      const bearer = parseBearerToken(headers);
      const workspaceId = decodeURIComponent(workspaceMatch[1] ?? "");
      void tokens.scopeForToken(bearer).then((scope) => {
        if (!scope) {
          socket.write(buildUnauthorizedUpgradeResponse(JSON.stringify({ code: "unauthorized", message: "Invalid bearer token" })));
          socket.destroy();
          return;
        }
        const actor: Actor = {
          type: "remote",
          clientId: headers.get("x-openwork-client-id") ?? undefined,
          tokenHash: hashToken(bearer),
          scope,
        };
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit("connection", ws, request, { mode: "workspace", workspaceId, actor });
        });
      }).catch(() => {
        socket.write(buildUnauthorizedUpgradeResponse(JSON.stringify({ code: "unauthorized", message: "Invalid bearer token" })));
        socket.destroy();
      });
      return true;
    }
    try {
      const { device } = bridge.authenticateDeviceRequest(request);
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request, { mode: "device", deviceId: device.id });
      });
    } catch (error) {
      const apiError = error instanceof ApiError
        ? error
        : new ApiError(401, "unauthorized", "Invalid device credentials");
      socket.write(buildUnauthorizedUpgradeResponse(JSON.stringify({ code: apiError.code, message: apiError.message })));
      socket.destroy();
    }
    return true;
  };
}
