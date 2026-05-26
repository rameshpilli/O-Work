import { describe, expect, test } from "bun:test";

import { DesktopBridgeService } from "./desktop-bridge.js";

describe("DesktopBridgeService", () => {
  test("enrollment tokens are single-use and create device credentials", () => {
    const bridge = new DesktopBridgeService();
    const issued = bridge.issueEnrollmentToken({ label: "QA laptop" });

    const enrolled = bridge.enrollDevice({
      enrollmentToken: issued.token,
      deviceName: "Ramesh MacBook",
      platform: "darwin",
      arch: "arm64",
      clientVersion: "0.0.1",
      metadata: { team: "eng" },
    });

    expect(enrolled.device.id).toMatch(/^dev_/);
    expect(enrolled.device.name).toBe("Ramesh MacBook");
    expect(enrolled.device.connected).toBe(false);
    expect(enrolled.device.metadata).toEqual({ team: "eng" });
    expect(enrolled.deviceToken).toMatch(/^owd_/);

    expect(() =>
      bridge.enrollDevice({
        enrollmentToken: issued.token,
        deviceName: "Second device",
      })).toThrow("Enrollment token has already been used");
  });

  test("queued calls flush after connect and complete through the device", () => {
    const bridge = new DesktopBridgeService();
    const issued = bridge.issueEnrollmentToken();
    const enrolled = bridge.enrollDevice({
      enrollmentToken: issued.token,
      deviceName: "Bridge POC",
    });

    const queued = bridge.createToolCall({
      deviceId: enrolled.device.id,
      toolName: "local-shell.exec",
      arguments: { command: "ls ~/Downloads" },
    });
    expect(queued.status).toBe("queued");

    const sent: unknown[] = [];
    const connected = bridge.connectDevice(enrolled.device.id, (message) => {
      sent.push(message);
    });

    expect(connected.queuedCalls).toHaveLength(1);
    expect((sent[0] as { type: string }).type).toBe("tool_call");

    const updated = bridge.getToolCall(queued.id);
    expect(updated.status).toBe("sent");

    const result = bridge.completeToolCall(enrolled.device.id, connected.connectionId, queued.id, {
      ok: true,
      output: { stdout: "Downloads\n" },
    });
    expect(result.status).toBe("completed");
    expect(result.result).toEqual({ stdout: "Downloads\n" });
  });
});
