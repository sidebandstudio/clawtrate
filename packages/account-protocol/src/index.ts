// The account's signing, device list and join, with no I/O. The README is the protocol's
// description. This file names everything the package offers; nothing else is reachable.

export { AccountProtocolError, type AccountProtocolErrorCode } from "./errors.ts";
export {
  JOIN_PAUSE_MS,
  MAX_ADDRESSES,
  MAX_AUDIENCE_BYTES,
  MAX_BODY_BYTES,
  MAX_ENTRIES,
  MAX_HOST_BYTES,
  MAX_MEMBERS,
  MAX_NAME_BYTES,
  MAX_PATH_BYTES,
  SESSION_SKEW_MS,
} from "./limits.ts";
export {
  GatewayDeviceKey,
  ListPublicKey,
  ListSecretKey,
  SealPublicKey,
  SealSecretKey,
  SessionPublicKey,
  SessionSecretKey,
} from "./keys.ts";
export { PLATFORMS, type DeviceRecord, type ListContext, type Platform } from "./records.ts";
export {
  assembleGenesis,
  decodeRemovalNotice,
  encodeRemovalNotice,
  entryHash,
  ListState,
  MAX_ENTRY_BYTES,
  readEntry,
  signGenesis,
  signRemoval,
  signRemovalNotice,
  signRestore,
  verifyList,
  type Entry,
  type GenesisFields,
  type Member,
  type Removal,
  type RemovalOrigin,
  type Role,
} from "./list.ts";
export { cardHash, checkCardForList, signCard, verifyCard, type Card, type CardAddress } from "./card.ts";
export {
  ListSecret,
  MAX_CARD_BYTES,
  MAX_LIST_BYTES,
  openCard,
  openEntry,
  openList,
  openRotation,
  rotateListSecret,
  sealCard,
  sealEntry,
  sealList,
} from "./seal.ts";
export {
  joinAnswer,
  joinChoices,
  joinCommit,
  joinConfirm,
  joinFinish,
  joinReveal,
  refuseJoin,
  verifyRefusal,
  wordsFor,
  type JoiningDevice,
  type JoinMember,
  type JoinOutcome,
  type JoinPick,
  type Refusal,
  type RefusalReason,
  type Words,
} from "./join.ts";
export {
  signSessionRequest,
  verifySessionRequest,
  type SessionMethod,
  type SessionRequestFields,
} from "./session.ts";
