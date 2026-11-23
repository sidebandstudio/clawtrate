// A newer OpenClaw, as the gateway's update check reports it (gateway-update.ts):
// read from `hello-ok` `snapshot.updateAvailable` and kept current by the
// `update.available` event.

import { describe, expect, it } from "vitest";
import { readOpenClawUpdate } from "../src/index.ts";
import { grantingGateway, openTask } from "./client-harness.ts";
import { helloOk, until } from "./fake-gateway.ts";

describe("F-534: the gateway's report of a newer OpenClaw", () => {
  it("reads the versions, and nothing that isn't a newer version", () => {
    expect(
      readOpenClawUpdate({
        currentVersion: "2026.10.6",
        latestVersion: "2026.11.6",
        channel: "latest",
      }),
    ).toEqual({ current: "2026.10.6", latest: "2026.11.6", channel: "latest" });
    expect(
      readOpenClawUpdate({
        currentVersion: "2026.11.6",
        latestVersion: "2026.11.10-beta.1",
        channel: "beta",
      }),
    ).toEqual({ current: "2026.11.6", latest: "2026.11.10-beta.1", channel: "beta" });
    // A channel that isn't a plain tag is not kept.
    expect(
      readOpenClawUpdate({ currentVersion: "1.0", latestVersion: "1.1", channel: "Beta!" }),
    ).toEqual({ current: "1.0", latest: "1.1", channel: null });
    expect(readOpenClawUpdate(null)).toBeNull();
    expect(readOpenClawUpdate({ currentVersion: "2026.10.6" })).toBeNull();
    expect(readOpenClawUpdate({ currentVersion: "1", latestVersion: "1" })).toBeNull();
    expect(
      readOpenClawUpdate({ currentVersion: "2026.10.6", latestVersion: "x; rm -rf" }),
    ).toBeNull();
    expect(
      readOpenClawUpdate({ currentVersion: "2026.10.6", latestVersion: "9".repeat(65) }),
    ).toBeNull();
    // Only something shaped like a version: a word means no notice.
    for (const word of ["unknown", "unavailable", "latest", "beta"]) {
      expect(readOpenClawUpdate({ currentVersion: word, latestVersion: "2026.11.6" })).toBeNull();
      expect(readOpenClawUpdate({ currentVersion: "2026.10.6", latestVersion: word })).toBeNull();
    }
    // A pre-release part, a build part, and both together, as OpenClaw writes them.
    for (const latestVersion of [
      "2026.11.6-beta.1",
      "2026.11.6+build.7",
      "2026.11.6-beta.1+build.7",
    ])
      expect(
        readOpenClawUpdate({ currentVersion: "v2026.10.6", latestVersion }),
        latestVersion,
      ).toMatchObject({ current: "v2026.10.6", latest: latestVersion });
    // Longer than 64 characters: no notice, never one cut short.
    expect(
      readOpenClawUpdate({ currentVersion: "2026.10.6", latestVersion: "2026." + "9".repeat(252) }),
    ).toBeNull();
    expect(
      readOpenClawUpdate({ currentVersion: "2026.10.6", latestVersion: "2026." + "9".repeat(60) }),
    ).toBeNull();
    expect(
      readOpenClawUpdate({ currentVersion: "2026.10.6", latestVersion: "2026." + "9".repeat(59) }),
    ).toMatchObject({ latest: "2026." + "9".repeat(59) });
  });

  it("comes from the hello, and follows update.available", async () => {
    const gateway = grantingGateway();
    gateway.connectReply = (params) => {
      const { scopes } = params as { scopes: string[] };
      const hello = helloOk(scopes, "device-token");
      return {
        ok: true,
        payload: {
          ...hello,
          snapshot: {
            ...hello.snapshot,
            updateAvailable: {
              currentVersion: "2026.10.6",
              latestVersion: "2026.11.6",
              channel: "latest",
            },
          },
        },
      };
    };
    const { client } = await openTask({ gateway });
    expect(client.state.connection.openclawUpdate).toEqual({
      current: "2026.10.6",
      latest: "2026.11.6",
      channel: "latest",
    });
    gateway.emit("update.available", {
      updateAvailable: {
        currentVersion: "2026.10.6",
        latestVersion: "2026.11.7",
        channel: "latest",
      },
    });
    await until(() => client.state.connection.openclawUpdate?.latest === "2026.11.7");
    gateway.emit("update.available", { updateAvailable: null });
    await until(() => client.state.connection.openclawUpdate === null);
    client.stop();
  });

  it("is absent when the hello reports none", async () => {
    const { client } = await openTask();
    expect(client.state.connection.openclawUpdate).toBeNull();
    client.stop();
  });
});
