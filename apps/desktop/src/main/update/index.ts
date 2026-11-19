// The update engine for the update screens (#69). Nothing imports it yet: a
// build of the app makes no request to an update host. docs/decisions.md,
// "Updates and release signing", says what it checks and what it does not.

export {
  UpdateEngine,
  DEFAULT_LIMITS,
  MAX_FEED_BYTES,
  FEED_TIMEOUT_MS,
  MAX_DOWNLOAD_BYTES,
  DOWNLOAD_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  type Limits,
  type NewerVersion,
  type UpdateEngineOptions,
  type UpdateFailureCause,
  type UpdateState,
} from "./engine.ts";
export {
  BUILD_FEED_ADDRESS,
  BUILD_RELEASE_DATE,
  UPDATE_REQUIRED_AFTER_MS,
  isUpdateRequired,
  productionUpdateEngine,
} from "./build-info.ts";
export { FEED_FORMAT, FILE_KEYS, fileKeyFor, type FileKey } from "./feed.ts";
export { type LoopbackHttpForTests } from "./address.ts";
