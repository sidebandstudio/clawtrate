// What a card's Raw panel shows: the gateway's record as it sent it, or why it
// is not here. Kept apart from the components so plain modules can name it.
import type { Row } from "./model.ts";

export type RawContent =
  | { state: "loading" }
  | { state: "unavailable"; reason: string }
  | { state: "failed"; retry: () => void }
  | {
      state: "loaded";
      /** The exact tool name, for a tool call. */
      tool?: string | null;
      args?: unknown;
      result?: unknown;
      error?: string | null;
      /** A tool call still running. */
      running?: boolean;
      /** Events as received, each under its own label. */
      events?: Array<[string, unknown]>;
      /** The gateway cut the result. */
      truncated?: boolean;
      timing?: Row[];
      ids: Row[];
      /** Plain sentences about what is not here, and why. */
      notes?: string[];
    };
