// The only runtime globals core relies on. Electron, Node, browsers and React
// Native all provide them; declaring them here keeps DOM and Node types out of core.

declare function setTimeout(callback: () => void, ms?: number): unknown;
declare function clearTimeout(handle: unknown): void;

declare class URL {
  constructor(input: string, base?: string);
  readonly protocol: string;
  readonly host: string;
  readonly hostname: string;
  toString(): string;
}
