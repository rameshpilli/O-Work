import { afterEach, describe, expect, test } from "bun:test";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

type Served = {
  port: number;
  stop: () => void | Promise<void>;
};

const HOST_TOKEN = "owt_desktop_bridge_host";
const stops: Array<() => void | Promise<void>> = [];

function baseConfig(): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "owt_desktop_bridge_client",
    hostToken: HOST_TOKEN,
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [],
    authorizedRoots: [],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
}

function hostAuth() {
  return {
    "x-openwork-host-token": HOST_TOKEN,
    "content-type": "application/json",
  };
}

async function boot() {
  const server = await startServer(baseConfig()) as Served;
  stops.push(() => server.stop());
  return {
    server,
    base: `http://127.0.0.1:${server.port}`,
  };
}

afterEach(async () => {
  while (stops.length) {
    await stops.pop()?.();
  }
});

describe("desktop bridge routes", () => {
  test("issues enrollment tokens, enrolls a device, queues a call, and accepts HTTP tool results", async () => {
    const { base } = await boot();

    const issuedResponse = await fetch(`${base}/desktop/enrollment-tokens`, {
      method: "POST",
      headers: hostAuth(),
      body: JSON.stringify({ label: "POC token", ttlMs: 60_000 }),
    });
    expect(issuedResponse.status).toBe(201);
    const issued = await issuedResponse.json() as { token: string; id: string };

    const listTokensResponse = await fetch(`${base}/desktop/enrollment-tokens`, {
      headers: { "x-openwork-host-token": HOST_TOKEN },
    });
    expect(listTokensResponse.status).toBe(200);
    const tokenList = await listTokensResponse.json() as {
      items: Array<{ id: string; label?: string; claimedByDeviceId: string | null }>;
    };
    expect(tokenList.items[0]).toMatchObject({ id: issued.id, label: "POC token", claimedByDeviceId: null });

    const enrollResponse = await fetch(`${base}/desktop/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enrollmentToken: issued.token,
        deviceName: "POC MacBook",
        platform: "darwin",
        arch: "arm64",
        clientVersion: "0.0.1",
        metadata: { department: "ai-platform" },
      }),
    });
    expect(enrollResponse.status).toBe(201);
    const enrolled = await enrollResponse.json() as {
      device: { id: string; connected: boolean; metadata: Record<string, unknown> };
      deviceToken: string;
      websocket: { url: string; path: string };
    };
    expect(enrolled.device.connected).toBe(false);
    expect(enrolled.device.metadata).toEqual({ department: "ai-platform" });
    expect(enrolled.websocket.path).toBe("/desktop/bridge");
    expect(enrolled.websocket.url).toContain(`/desktop/bridge?device_id=${enrolled.device.id}`);

    const devicesResponse = await fetch(`${base}/desktop/devices`, {
      headers: { "x-openwork-host-token": HOST_TOKEN },
    });
    expect(devicesResponse.status).toBe(200);
    const devicesBody = await devicesResponse.json() as {
      items: Array<{ id: string; connected: boolean; tools: unknown[] }>;
    };
    expect(devicesBody.items).toEqual([
      expect.objectContaining({
        id: enrolled.device.id,
        connected: false,
        tools: [],
      }),
    ]);

    const toolCallResponse = await fetch(`${base}/desktop/devices/${enrolled.device.id}/tool-calls`, {
      method: "POST",
      headers: hostAuth(),
      body: JSON.stringify({
        toolName: "local-shell.exec",
        arguments: { command: "ls ~/Downloads" },
        timeoutMs: 15_000,
      }),
    });
    expect(toolCallResponse.status).toBe(202);
    const toolCallBody = await toolCallResponse.json() as {
      item: { id: string; status: string; timeoutMs: number };
    };
    expect(toolCallBody.item.status).toBe("queued");
    expect(toolCallBody.item.timeoutMs).toBe(15_000);

    const callListResponse = await fetch(`${base}/desktop/devices/${enrolled.device.id}/tool-calls`, {
      headers: { "x-openwork-host-token": HOST_TOKEN },
    });
    expect(callListResponse.status).toBe(200);
    const callListBody = await callListResponse.json() as {
      items: Array<{ id: string; status: string }>;
    };
    expect(callListBody.items[0]).toMatchObject({ id: toolCallBody.item.id, status: "queued" });

    const resultResponse = await fetch(`${base}/desktop/tool-calls/${toolCallBody.item.id}/result?device_id=${encodeURIComponent(enrolled.device.id)}&device_token=${encodeURIComponent(enrolled.deviceToken)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ok: true,
        output: {
          stdout: "/Users/rameshpilli/Downloads/demo.csv\n",
        },
      }),
    });
    expect(resultResponse.status).toBe(200);
    const resultBody = await resultResponse.json() as {
      ok: boolean;
      item: { id: string; status: string; result: { stdout: string } };
    };
    expect(resultBody.ok).toBe(true);
    expect(resultBody.item).toMatchObject({
      id: toolCallBody.item.id,
      status: "completed",
      result: { stdout: "/Users/rameshpilli/Downloads/demo.csv\n" },
    });

    const finalResponse = await fetch(`${base}/desktop/tool-calls/${toolCallBody.item.id}`, {
      headers: { "x-openwork-host-token": HOST_TOKEN },
    });
    expect(finalResponse.status).toBe(200);
    const finalBody = await finalResponse.json() as {
      item: { status: string; result: { stdout: string } };
    };
    expect(finalBody.item.status).toBe("completed");
    expect(finalBody.item.result.stdout).toContain("/Users/rameshpilli/Downloads/demo.csv");
  });
});
