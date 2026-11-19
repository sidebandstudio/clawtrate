// The SSH transport of "Another computer". docs/decisions.md, "SSH to another
// computer", says how it is built and what it refuses.

export {
  productionWorld,
  guardWorld,
  isAutomatedRun,
  SshWorldRefused,
  type SshWorld,
} from "./world.ts";
export { parseDestination, type Destination } from "./destination.ts";
export type { ConfigRefusal, RefusalCategory, Target } from "./person-config.ts";
export type { SshFailure, UnreachableCause } from "./ssh-output.ts";
export type { GatewayService, LookFacts, GatewayStatus, Version } from "./look.ts";
export { serviceOnPort, sameService, PROGRAM_PLACES, type FoundService } from "./look.ts";
export {
  BACKOFF_MS,
  BACKOFF_STEADY_MS,
  LONG_OUTAGE_MS,
  type ForwardCause,
  type ForwardState,
  type ForwardSupervisor,
} from "./forward.ts";
export {
  SshTransport,
  failureNote,
  CAPTURE_TTL_MS,
  type FailureNote,
  type Failed,
  type HostKeyCheck,
  type InvalidDestination,
  type LookResult,
  type NotSupportedHere,
  type OpenForwardResult,
  type StaleRoute,
  type AppFilesUnsafe,
  forwardNote,
  type PinResult,
  type Route,
  type ShownKey,
} from "./transport.ts";
