// The only runtime globals the relay protocol relies on. Node, Electron, Workers and
// React Native provide them; declaring them here keeps DOM and Node types out.

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  decode(input?: Uint8Array): string;
}
