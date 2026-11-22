import type { Server } from "node:net";
import { spawnSync } from "node:child_process";
import type { DevInstance } from "../../../tools/dev-gateway/src/cli.ts";
import { provenEndpoint } from "../../../tools/dev-gateway/src/endpoint.ts";
import { readMarker } from "../../../tools/dev-gateway/src/state-guard.ts";

/** Hold one named run for the whole experiment, including automatic reconnects. */
export function probeEndpoint(inst: DevInstance) {
  if (!inst.name) throw new Error("A named development instance is required");
  const read = () => {
    const proof = provenEndpoint({
      instance: inst.name,
      home: inst.home,
      runDir: inst.runDir,
      checkout: inst.checkout,
    });
    if ("refusal" in proof) throw new Error(proof.refusal);
    const marker = readMarker(inst.stateDir);
    const port = new URL(proof.url).port;
    const listeners = spawnSync("lsof", ["-nP", "-i4TCP:" + port, "-sTCP:LISTEN", "-Fp"], {
      encoding: "utf8",
      timeout: 3000,
    });
    const owners = (listeners.stdout ?? "").split("\n").filter((line) => line.startsWith("p"));
    if (
      !marker?.gatewayPid ||
      listeners.status !== 0 ||
      owners.length !== 1 ||
      owners[0] !== "p" + marker.gatewayPid
    ) {
      throw new Error(
        "Cannot verify that the named gateway owns the listener; the probe requires lsof",
      );
    }
    return { ...proof, runId: marker.runId };
  };
  const original = read();
  return {
    url: original.url,
    token: original.token,
    recheck() {
      const now = read();
      if (
        now.runId !== original.runId ||
        now.url !== original.url ||
        now.token !== original.token
      ) {
        throw new Error("The named development gateway changed during the probe");
      }
    },
  };
}

/** A proxy belongs to the experiment only while its own server holds the socket. */
export function probeTarget(endpoint: ReturnType<typeof probeEndpoint>, proxy?: Server) {
  const targetUrl = () => {
    if (!proxy) return endpoint.url;
    const address = proxy.address();
    if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
      throw new Error("The probe proxy is no longer listening on loopback");
    }
    return `ws://127.0.0.1:${address.port}`;
  };
  const url = targetUrl();
  return {
    url,
    beforeConnect() {
      endpoint.recheck();
      if (targetUrl() !== url) throw new Error("The probe proxy changed");
    },
  };
}
