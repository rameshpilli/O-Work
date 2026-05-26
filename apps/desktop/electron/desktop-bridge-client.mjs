import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

import {
  desktopBridgeConfigPath,
  normalizeDesktopBridgeConfig,
  readDesktopBridgeConfig,
  redactedDesktopBridgeConfig,
  writeDesktopBridgeConfig,
} from "./desktop-bridge-config.mjs";
import { createDesktopLocalToolAdapter } from "./desktop-local-tools.mjs";

function trim(value) {
  return String(value ?? "").trim();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toWebSocketUrl(config) {
  if (trim(config.websocketUrl)) return trim(config.websocketUrl);
  const serverUrl = trim(config.serverUrl).replace(/\/+$/, "");
  if (!serverUrl) return "";
  return `${serverUrl.replace(/^http/i, "ws")}/desktop-bridge/v1/connect`;
}

function backoffDelay(attempt, config) {
  const min = Math.max(250, Number(config?.reconnect?.minDelayMs ?? 1_000));
  const max = Math.max(min, Number(config?.reconnect?.maxDelayMs ?? 15_000));
  return Math.min(max, min * (2 ** Math.max(0, attempt - 1)));
}

function protocolError(message, code = "PROTOCOL_ERROR") {
  return Object.assign(new Error(message), { code });
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeServerPolicyRoots(roots, homeDir) {
  if (!Array.isArray(roots)) return [];
  return roots
    .map((entry) => trim(entry))
    .filter(Boolean)
    .map((entry) => {
      if (entry === "~") return homeDir;
      if (entry.startsWith("~/")) return path.join(homeDir, entry.slice(2));
      return path.resolve(entry);
    });
}

function intersectRoots(localRoots, serverRoots) {
  if (!serverRoots.length) return [...localRoots];
  return serverRoots.filter((serverRoot) =>
    localRoots.some((localRoot) => isPathInside(localRoot, serverRoot) || isPathInside(serverRoot, localRoot)),
  );
}

export function createDesktopBridgeClient(input) {
  const userDataDir = input.userDataDir;
  const appVersion = trim(input.appVersion) || "0.0.0";
  const appName = trim(input.appName) || "OpenWork";
  const homeDir = input.homeDir || os.homedir();
  const log = typeof input.log === "function" ? input.log : (...args) => console.info("[desktop-bridge]", ...args);
  const logError = typeof input.logError === "function" ? input.logError : (...args) => console.warn("[desktop-bridge]", ...args);
  const requestApproval = typeof input.requestApproval === "function"
    ? input.requestApproval
    : async () => ({ approved: false, reason: "No desktop approval handler is configured." });
  const extraTools = Array.isArray(input.extraTools) ? input.extraTools.filter(Boolean) : [];

  let currentConfig = null;
  let localTools = null;
  let currentServerPolicy = null;
  let socket = null;
  let heartbeatTimer = null;
  let connectLoopPromise = null;
  let restartPromise = Promise.resolve();
  let disposed = false;
  let shouldBeRunning = false;
  let reconnectAttempt = 0;
  let connectionNonce = 0;

  const state = {
    phase: "idle",
    currentUrl: "",
    lastError: null,
    connectedAt: null,
    disconnectedAt: null,
    lastAdvertisedAt: null,
    lastHeartbeatAt: null,
    lastToolCallAt: null,
    deviceId: "",
    deviceName: "",
    serverUrl: "",
    websocketUrl: "",
    activeCalls: 0,
    tools: [],
  };

  function updateState(patch) {
    Object.assign(state, patch);
  }

  function snapshotStatus() {
    return {
      ...state,
      configPath: desktopBridgeConfigPath(userDataDir),
      config: currentConfig ? redactedDesktopBridgeConfig(currentConfig) : null,
      allowedRoots: localTools?.policy?.allowedRoots ?? [],
      allowedCommands: localTools?.policy?.allowedCommands ?? [],
      serverPolicy: currentServerPolicy,
    };
  }

  async function rebuildLocalTools() {
    if (!currentConfig) return null;
    const serverRoots = normalizeServerPolicyRoots(currentServerPolicy?.allowedRoots ?? [], homeDir);
    const allowedRoots = intersectRoots(currentConfig.allowedRoots ?? [], serverRoots);
    const allowedCommands = Array.isArray(currentServerPolicy?.shell?.allowedCommands)
      ? currentServerPolicy.shell.allowedCommands.map((entry) => trim(entry).toLowerCase()).filter(Boolean)
      : undefined;
    localTools = await createDesktopLocalToolAdapter({
      homeDir,
      allowedRoots,
      allowedCommands,
      extraTools,
      limits: currentConfig.limits,
    });
    updateState({ tools: localTools.describeTools().map((tool) => tool.name) });
    return localTools;
  }

  async function loadConfig() {
    const next = await readDesktopBridgeConfig(userDataDir, { homeDir });
    currentConfig = next;
    updateState({
      deviceId: next.deviceId,
      deviceName: next.deviceName,
      serverUrl: next.serverUrl,
      websocketUrl: toWebSocketUrl(next),
    });
    await rebuildLocalTools();
    return next;
  }

  function clearHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function closeSocket() {
    if (!socket) return;
    try {
      socket.close();
    } catch {
      // ignore
    }
    clearHeartbeat();
  }

  function send(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw protocolError("Desktop bridge socket is not connected", "SOCKET_NOT_CONNECTED");
    }
    socket.send(JSON.stringify(message));
  }

  function advertiseCapabilities() {
    if (!localTools || !currentConfig) return;
    send({
      type: "capabilities_advertise",
      protocolVersion: 1,
      deviceId: currentConfig.deviceId,
      deviceName: currentConfig.deviceName,
      tools: localTools.describeTools(),
      allowedRoots: localTools.policy.allowedRoots,
      platform: process.platform,
      arch: process.arch,
    });
    updateState({ lastAdvertisedAt: new Date().toISOString() });
  }

  function helloMessage(config) {
    return {
      type: "client_hello",
      protocolVersion: 1,
      token: config.enrollmentToken,
      device: {
        id: config.deviceId,
        name: config.deviceName,
        platform: process.platform,
        arch: process.arch,
        hostname: os.hostname(),
        appName,
        appVersion,
      },
    };
  }

  async function handleToolCall(payload) {
    const callId = trim(payload?.callId || payload?.id);
    const toolName = trim(payload?.toolName || payload?.name);
    if (!callId) throw protocolError("tool_call is missing callId", "INVALID_TOOL_CALL");
    if (!toolName) throw protocolError("tool_call is missing toolName", "INVALID_TOOL_CALL");
    updateState({
      activeCalls: state.activeCalls + 1,
      lastToolCallAt: new Date().toISOString(),
    });

    send({ type: "tool_started", callId, toolName });
    try {
      const result = await localTools.executeToolCall(toolName, payload?.input ?? payload?.arguments ?? {}, {
        onStdout(chunk) {
          send({ type: "tool_stdout", callId, chunk: String(chunk) });
        },
        onStderr(chunk) {
          send({ type: "tool_stderr", callId, chunk: String(chunk) });
        },
      });
      send({ type: "tool_result", callId, toolName, ok: true, result });
    } catch (error) {
      send({
        type: "tool_result",
        callId,
        toolName,
        ok: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
          ...(error?.code ? { code: error.code } : {}),
        },
      });
    } finally {
      updateState({ activeCalls: Math.max(0, state.activeCalls - 1) });
    }
  }

  async function handleApprovalRequest(payload) {
    const callId = trim(payload?.callId || payload?.id);
    const toolName = trim(payload?.toolName || payload?.name);
    if (!callId) throw protocolError("approval_request is missing callId", "INVALID_APPROVAL_REQUEST");
    if (!toolName) throw protocolError("approval_request is missing toolName", "INVALID_APPROVAL_REQUEST");
    const decision = await requestApproval({
      callId,
      toolName,
      input: payload?.input ?? payload?.arguments ?? {},
      approval: payload?.approval ?? null,
      policy: currentServerPolicy,
    });
    send({
      type: "approval_response",
      callId,
      toolName,
      approved: decision?.approved === true,
      ...(trim(decision?.reason) ? { reason: trim(decision.reason) } : {}),
    });
  }

  async function handleMessage(raw) {
    let payload;
    try {
      payload = JSON.parse(String(raw));
    } catch {
      throw protocolError("Desktop bridge received invalid JSON", "INVALID_JSON");
    }
    switch (payload?.type) {
      case "server_hello":
      case "enrolled":
        if (payload?.deviceId && currentConfig && payload.deviceId !== currentConfig.deviceId) {
          currentConfig = { ...currentConfig, deviceId: trim(payload.deviceId) };
          await writeDesktopBridgeConfig(userDataDir, currentConfig, { homeDir });
          updateState({ deviceId: currentConfig.deviceId });
        }
        advertiseCapabilities();
        return;
      case "policy_update":
        currentServerPolicy = payload?.policy ?? null;
        await rebuildLocalTools();
        advertiseCapabilities();
        return;
      case "capabilities_request":
        advertiseCapabilities();
        return;
      case "approval_request":
        await handleApprovalRequest(payload);
        return;
      case "tool_call":
        await handleToolCall(payload);
        return;
      case "ack":
      case "error":
        return;
      case "ping":
        send({ type: "pong", at: new Date().toISOString() });
        updateState({ lastHeartbeatAt: new Date().toISOString() });
        return;
      case "revoke":
        log("Received desktop bridge revoke", payload?.reason ?? "");
        await stop();
        return;
      default:
        send({
          type: "client_error",
          code: "UNKNOWN_MESSAGE_TYPE",
          message: `Unknown desktop bridge message type: ${payload?.type ?? "<missing>"}`,
        });
    }
  }

  function installHeartbeat() {
    clearHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (!socket || socket.readyState !== WebSocket.OPEN || !currentConfig) return;
      try {
        send({
          type: "heartbeat",
          at: new Date().toISOString(),
          deviceId: currentConfig.deviceId,
          activeCalls: state.activeCalls,
        });
        updateState({ lastHeartbeatAt: new Date().toISOString() });
      } catch (error) {
        logError("Heartbeat failed", error);
      }
    }, 15_000);
  }

  async function connectOnce(config, nonce) {
    const wsUrl = toWebSocketUrl(config);
    if (!wsUrl) {
      updateState({ phase: "disabled" });
      return false;
    }
    updateState({
      phase: "connecting",
      currentUrl: wsUrl,
      serverUrl: config.serverUrl,
      websocketUrl: wsUrl,
      lastError: null,
    });

    await new Promise((resolve, reject) => {
      const nextSocket = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${config.enrollmentToken}`,
          "X-OpenWork-Device-Id": config.deviceId,
        },
      });
      let opened = false;
      const cleanup = () => {
        nextSocket.removeAllListeners("open");
        nextSocket.removeAllListeners("message");
        nextSocket.removeAllListeners("close");
        nextSocket.removeAllListeners("error");
      };
      nextSocket.on("open", () => {
        if (disposed || nonce !== connectionNonce) {
          cleanup();
          nextSocket.close();
          resolve();
          return;
        }
        opened = true;
        socket = nextSocket;
        updateState({
          phase: "connected",
          connectedAt: new Date().toISOString(),
          disconnectedAt: null,
        });
        installHeartbeat();
        send(helloMessage(config));
        advertiseCapabilities();
        resolve();
      });
      nextSocket.on("message", async (payload) => {
        try {
          await handleMessage(payload);
        } catch (error) {
          logError("Desktop bridge message handling failed", error);
          try {
            send({
              type: "client_error",
              code: error?.code ?? "MESSAGE_HANDLER_FAILED",
              message: error instanceof Error ? error.message : String(error),
            });
          } catch {
            // ignore send failures
          }
        }
      });
      nextSocket.on("close", (_code, reasonBuffer) => {
        cleanup();
        if (socket === nextSocket) socket = null;
        clearHeartbeat();
        updateState({
          phase: shouldBeRunning ? "reconnecting" : "idle",
          disconnectedAt: new Date().toISOString(),
          lastError: opened ? null : trim(reasonBuffer?.toString("utf8")),
        });
        if (!opened) {
          reject(protocolError(trim(reasonBuffer?.toString("utf8")) || "Desktop bridge socket closed during connect", "SOCKET_CLOSED"));
        }
      });
      nextSocket.on("error", (error) => {
        if (!opened) {
          reject(error);
          return;
        }
        logError("Desktop bridge socket error", error);
      });
    });

    return true;
  }

  async function runConnectLoop() {
    while (!disposed && shouldBeRunning) {
      const config = await loadConfig();
      if (!config.enabled || !config.serverUrl || !config.enrollmentToken) {
        updateState({ phase: "disabled", lastError: null });
        return;
      }
      const nonce = ++connectionNonce;
      try {
        const connected = await connectOnce(config, nonce);
        if (!connected) return;
        reconnectAttempt = 0;
        await new Promise((resolve) => {
          const activeSocket = socket;
          if (!activeSocket) {
            resolve();
            return;
          }
          activeSocket.once("close", () => resolve());
        });
      } catch (error) {
        reconnectAttempt += 1;
        updateState({
          phase: "reconnecting",
          lastError: error instanceof Error ? error.message : String(error),
          disconnectedAt: new Date().toISOString(),
        });
        if (!shouldBeRunning || disposed) return;
        const waitMs = backoffDelay(reconnectAttempt, config);
        logError(`Desktop bridge connect failed; retrying in ${waitMs}ms`, error);
        await delay(waitMs);
      }
    }
  }

  async function start() {
    if (disposed) throw protocolError("Desktop bridge client is disposed", "CLIENT_DISPOSED");
    shouldBeRunning = true;
    if (!connectLoopPromise) {
      connectLoopPromise = runConnectLoop().finally(() => {
        connectLoopPromise = null;
      });
    }
    return snapshotStatus();
  }

  async function stop() {
    shouldBeRunning = false;
    connectionNonce += 1;
    closeSocket();
    clearHeartbeat();
    updateState({
      phase: "idle",
      currentUrl: "",
      disconnectedAt: new Date().toISOString(),
    });
    return snapshotStatus();
  }

  async function restart() {
    restartPromise = restartPromise.then(async () => {
      await stop();
      await start();
    });
    await restartPromise;
    return snapshotStatus();
  }

  async function setEnrollment(nextConfig) {
    const normalized = await writeDesktopBridgeConfig(userDataDir, nextConfig, { homeDir });
    currentConfig = normalizeDesktopBridgeConfig(normalized, { homeDir });
    updateState({
      deviceId: currentConfig.deviceId,
      deviceName: currentConfig.deviceName,
      serverUrl: currentConfig.serverUrl,
      websocketUrl: toWebSocketUrl(currentConfig),
    });
    localTools = await createDesktopLocalToolAdapter({
      homeDir,
      allowedRoots: currentConfig.allowedRoots,
      limits: currentConfig.limits,
    });
    updateState({ tools: localTools.describeTools().map((tool) => tool.name) });
    if (currentConfig.enabled && currentConfig.serverUrl && currentConfig.enrollmentToken) {
      await restart();
    } else {
      await stop();
    }
    return redactedDesktopBridgeConfig(currentConfig);
  }

  async function getEnrollment() {
    if (!currentConfig) await loadConfig();
    return currentConfig;
  }

  async function status() {
    if (!currentConfig) await loadConfig();
    return snapshotStatus();
  }

  async function dispose() {
    disposed = true;
    shouldBeRunning = false;
    await stop();
  }

  return {
    start,
    stop,
    restart,
    dispose,
    status,
    getEnrollment,
    setEnrollment,
  };
}
