// The cards in a task's transcript: approvals, questions and the Messaged
// cards. The transcript mounts them through CardScope, CardSlot and
// TrailingCards; the shell supplies OpenTaskContext; a host that knows which
// tool server is T3 Code supplies CardSettingsContext.
export {
  CardSettingsContext,
  OpenTaskContext,
  useStepHandover,
  type CardSettings,
  type OpenTask,
} from "./context.tsx";
export {
  CardFor,
  CardScope,
  CardSlot,
  PlacedCardsContext,
  refKey,
  useScopeCards,
  focusPending,
  RunCardList,
  TrailingCards,
} from "./TranscriptCards.tsx";
export {
  cardDomId,
  codingCalls,
  oldestPending,
  placeCards,
  type CardPlacement,
  type CardRef,
} from "./placement.ts";
