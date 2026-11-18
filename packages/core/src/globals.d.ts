// The only runtime globals core relies on. Electron, Node, browsers and React
// Native all provide them; declaring them here keeps DOM and Node types out of core.

declare function setTimeout(callback: () => void, ms?: number): unknown;
declare function clearTimeout(handle: unknown): void;

/** Ends a request that waits (a sign-in's next step) when it is cancelled or its connection goes. */
declare class AbortSignal {
  readonly aborted: boolean;
}
declare class AbortController {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}

declare class URL {
  constructor(input: string, base?: string);
  readonly protocol: string;
  readonly host: string;
  readonly hostname: string;
  toString(): string;
}
