// The only runtime globals the package uses besides the language. Node, Electron, Workers
// and React Native provide both; declaring them here keeps DOM and Node types out.

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  decode(input?: Uint8Array): string;
}
