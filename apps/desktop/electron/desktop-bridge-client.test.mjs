import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { WebSocketServer } from "ws";

import { createDesktopBridgeClient } from "./desktop-bridge-client.mjs";
import { writeDesktopBridgeConfig } from "./desktop-bridge-config.mjs";

function deferred() {
  /** @type {(value: import("ws").WebSocket) => void} */
  let resolve = () => {};
  /** @type {(error?: unknown) => void} */
  let reject = () => {};
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(check, timeoutMs = 10_000) {
  const startedAt = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

let tempRoot = "";
let userDataDir = "";
let allowedRoot = "";
let server = null;
let wsServer = null;
let client = null;
let connectUrl = "";
const messages = [];
const toolResults = new Map();
const connected = deferred();

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "openwork-bridge-client-"));
  userDataDir = path.join(tempRoot, "userdata");
  allowedRoot = path.join(tempRoot, "allowed");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(allowedRoot, { recursive: true });
  await writeFile(path.join(allowedRoot, "hello.txt"), "bridge hello\n", "utf8");
  await writeFile(path.join(allowedRoot, "todo.txt"), "TODO desktop bridge\n", "utf8");

  server = createServer();
  wsServer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (!request.url?.startsWith("/desktop-bridge/v1/connect")) {
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(request, socket, head, (websocket) => {
      wsServer.emit("connection", websocket, request);
    });
  });
  wsServer.on("connection", (websocket, request) => {
    messages.push({
      type: "connected",
      authorization: request.headers.authorization ?? "",
      deviceId: request.headers["x-openwork-device-id"] ?? "",
    });
    connected.resolve(websocket);
    websocket.on("message", (raw) => {
      const payload = JSON.parse(String(raw));
      messages.push(payload);
      if (payload.type === "client_hello") {
        websocket.send(JSON.stringify({
          type: "server_hello",
          deviceId: payload.device?.id,
        }));
      }
      if (payload.type === "tool_result") {
        toolResults.set(payload.callId, payload);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  connectUrl = `http://127.0.0.1:${port}`;

  await writeDesktopBridgeConfig(
    userDataDir,
    {
      enabled: true,
      serverUrl: connectUrl,
      enrollmentToken: "test-enrollment-token",
      allowedRoots: [allowedRoot],
      deviceName: "Bridge Test Device",
    },
    { homeDir: tempRoot },
  );

  client = createDesktopBridgeClient({
    userDataDir,
    appName: "OpenWork Test",
    appVersion: "1.0.0-test",
    homeDir: tempRoot,
  });
  await client.start();
  await connected.promise;
  await waitFor(() => messages.some((entry) => entry.type === "capabilities_advertise"));
});

after(async () => {
  await client?.dispose().catch(() => undefined);
  await new Promise((resolve) => wsServer.close(() => resolve(undefined)));
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  await rm(tempRoot, { recursive: true, force: true });
});

describe("desktop bridge client", () => {
  it("connects with the enrollment token and advertises local tools", async () => {
    const connection = messages.find((entry) => entry.type === "connected");
    assert.equal(connection.authorization, "Bearer test-enrollment-token");
    const hello = messages.find((entry) => entry.type === "client_hello");
    assert.equal(hello.device.name, "Bridge Test Device");
    const advertised = messages.find((entry) => entry.type === "capabilities_advertise");
    assert.ok(advertised.tools.some((tool) => tool.name === "local-fs.list"));
    assert.ok(advertised.tools.some((tool) => tool.name === "local-shell.exec"));
  });

  it("executes local-fs.list and local-fs.read tool calls", async () => {
    const websocket = await connected.promise;
    websocket.send(JSON.stringify({
      type: "tool_call",
      callId: "call-list",
      toolName: "local-fs.list",
      input: { path: allowedRoot },
    }));
    websocket.send(JSON.stringify({
      type: "tool_call",
      callId: "call-read",
      toolName: "local-fs.read",
      input: { path: path.join(allowedRoot, "hello.txt") },
    }));

    const listResult = await waitFor(() => toolResults.get("call-list"));
    const readResult = await waitFor(() => toolResults.get("call-read"));
    assert.equal(listResult.ok, true);
    assert.ok(listResult.result.entries.some((entry) => entry.name === "hello.txt"));
    assert.equal(readResult.ok, true);
    assert.match(readResult.result.content, /bridge hello/);
  });

  it("executes a restricted local shell command from a tool call", async () => {
    const websocket = await connected.promise;
    websocket.send(JSON.stringify({
      type: "tool_call",
      callId: "call-shell",
      toolName: "local-shell.exec",
      input: {
        command: "ls",
        paths: [allowedRoot],
      },
    }));
    const shellResult = await waitFor(() => toolResults.get("call-shell"));
    assert.equal(shellResult.ok, true);
    assert.match(shellResult.result.stdout, /hello\.txt/);
  });
});
