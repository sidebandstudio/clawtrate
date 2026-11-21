// Where the device-node probe may connect. The probe sends the instance's
// token, so before every connection it proves, as the desktop host does
// (`provenEndpoint`), that this checkout started the named instance, that its
// marker, run file and connection file agree on the run and the port, and that
// the gateway process the tool recorded is alive now. A connection record left
// behind by a stopped gateway, whose loopback port another process now holds,
// is refused before any credential leaves.

import { dirname } from "node:path";
import { provenEndpoint, type ProvenEndpoint } from "../../../tools/dev-gateway/src/endpoint.ts";
import type { Identify } from "../../../tools/dev-gateway/src/state-guard.ts";

export type ProbeInstance = { home: string; checkout: string; connectionFile: string; identify: Identify };

export function probeEndpoint(inst: ProbeInstance, name: string): ProvenEndpoint {
  const proof = provenEndpoint({
    instance: name,
    home: inst.home,
    runDir: dirname(inst.connectionFile),
    checkout: inst.checkout,
    identify: inst.identify,
  });
  if ("refusal" in proof) throw new Error(`not probing instance "${name}": ${proof.refusal}`);
  return proof;
}
