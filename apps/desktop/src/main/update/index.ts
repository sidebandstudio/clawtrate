// Main-process update feed and download primitives.
export {
  UpdateEngine,
  DEFAULT_LIMITS,
  MAX_FEED_BYTES,
  FEED_TIMEOUT_MS,
  MAX_DOWNLOAD_BYTES,
  DOWNLOAD_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  UPDATE_REQUIRED_AFTER_MS,
  isUpdateRequired,
  type Limits,
  type NewerVersion,
  type UpdateEngineOptions,
  type UpdateFailureCause,
  type UpdateState,
} from "./engine.ts";
export { BUILD_FEED_ADDRESS, BUILD_RELEASE_DATE, productionUpdateEngine } from "./build-info.ts";
export { FEED_FORMAT, FILE_KEYS, fileKeyFor, type FileKey } from "./feed.ts";
export { type LoopbackHttpForTests } from "./address.ts";
