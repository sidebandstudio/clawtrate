// The cards in a task's transcript: approvals, questions and the Messaged
// cards. The transcript mounts them through CardScope, CardSlot and
// TrailingCards; the shell supplies OpenTaskContext.
export { OpenTaskContext, useStepHandover, type OpenTask } from "./context.tsx";
export {
  CardScope,
  CardSlot,
  focusPending,
  RunCardList,
  TrailingCards,
} from "./TranscriptCards.tsx";
export { oldestPending, placeCards, type CardPlacement, type CardRef } from "./placement.ts";
