// The one encoding: fixed-width big-endian integers, fixed-length byte strings, and
// variable-length byte strings and text with a two-byte length in front. Nothing is optional
// and nothing is skipped, so each value has exactly one encoding. A reader refuses anything
// short, long, over its bound or left over.

import { sha256 } from "@noble/hashes/sha2.js";
import { fail } from "./errors.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Control characters, bidirectional formatting characters and default-ignorable (invisible)
 * characters, refused in every text field.
 */
const UNSAFE_TEXT = /[\p{Cc}\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]/u;

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/**
 * An owned copy as a plain `Uint8Array`. `slice()` is not used for this: on a Node buffer,
 * which callers may pass, it returns a view that shares the caller's memory.
 */
export function copy(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Equal in time that depends only on the lengths, which are never secret here. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** SHA-256 over a fixed tag and then the parts. Every part is fixed-length or a full encoding. */
export function taggedHash(tag: string, ...parts: Uint8Array[]): Uint8Array {
  return sha256(concat(utf8(tag), ...parts));
}

export function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Checks a caller's argument: a programming error, not input from the wire. */
export function checkLength(bytes: Uint8Array, length: number, what: string): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
    fail("bad_argument", `${what} must be ${length} bytes`);
  }
  return bytes;
}

function checkText(text: string, min: number, max: number, what: string): Uint8Array {
  if (typeof text !== "string" || !text.isWellFormed()) fail("malformed", `${what} is not text`);
  if (UNSAFE_TEXT.test(text)) fail("malformed", `${what} holds a control character`);
  const bytes = encoder.encode(text);
  if (bytes.length < min) fail("malformed", `${what} is empty`);
  if (bytes.length > max) fail("too_large", `${what} is over ${max} bytes`);
  return bytes;
}

export class Writer {
  readonly #parts: Uint8Array[] = [];

  label(label: string): this {
    this.#parts.push(encoder.encode(label));
    return this;
  }

  u8(value: number): this {
    this.#parts.push(Uint8Array.of(value));
    return this;
  }

  u16(value: number): this {
    this.#parts.push(Uint8Array.of(value >>> 8, value & 0xff));
    return this;
  }

  u32(value: number): this {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value);
    this.#parts.push(out);
    return this;
  }

  /** A nonnegative safe integer, as eight bytes. */
  u64(value: number): this {
    if (!Number.isSafeInteger(value) || value < 0) fail("bad_time", "not a whole number of ms");
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, BigInt(value));
    this.#parts.push(out);
    return this;
  }

  fixed(bytes: Uint8Array, length: number, what: string): this {
    if (bytes.length !== length) fail("malformed", `${what} must be ${length} bytes`);
    this.#parts.push(copy(bytes));
    return this;
  }

  bytes(bytes: Uint8Array, min: number, max: number, what: string): this {
    if (bytes.length < min) fail("malformed", `${what} is too short`);
    if (bytes.length > max) fail("too_large", `${what} is over ${max} bytes`);
    this.u16(bytes.length);
    this.#parts.push(copy(bytes));
    return this;
  }

  text(text: string, min: number, max: number, what: string): this {
    const bytes = checkText(text, min, max, what);
    this.u16(bytes.length);
    this.#parts.push(bytes);
    return this;
  }

  finish(): Uint8Array {
    return concat(...this.#parts);
  }
}

export class Reader {
  readonly #bytes: Uint8Array;
  #at = 0;

  constructor(bytes: Uint8Array) {
    if (!(bytes instanceof Uint8Array)) fail("malformed", "not bytes");
    this.#bytes = bytes;
  }

  get offset(): number {
    return this.#at;
  }

  #take(length: number, what: string): Uint8Array {
    if (this.#bytes.length - this.#at < length) fail("malformed", `${what} is cut short`);
    const out = copy(this.#bytes.subarray(this.#at, this.#at + length));
    this.#at += length;
    return out;
  }

  /**
   * The object's label, exactly. The same kind with another version is `unsupported_version`;
   * anything else is `malformed`.
   */
  label(label: string): void {
    const expected = encoder.encode(label);
    const start = this.#bytes.subarray(0, expected.length);
    if (this.#at === 0 && equalBytes(start, expected)) {
      this.#at = expected.length;
      return;
    }
    const kind = encoder.encode(label.slice(0, label.lastIndexOf(" v") + 2));
    if (equalBytes(this.#bytes.subarray(0, kind.length), kind)) {
      fail("unsupported_version", "this kind with another version");
    }
    fail("malformed", "not the expected kind");
  }

  u8(): number {
    return this.#take(1, "a byte")[0]!;
  }

  u16(): number {
    const b = this.#take(2, "a length");
    return (b[0]! << 8) | b[1]!;
  }

  u32(): number {
    const b = this.#take(4, "a number");
    return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0);
  }

  u64(what: string): number {
    const b = this.#take(8, what);
    const value = new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(0);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail("bad_time", `${what} is out of range`);
    return Number(value);
  }

  fixed(length: number, what: string): Uint8Array {
    return this.#take(length, what);
  }

  bytes(min: number, max: number, what: string): Uint8Array {
    const length = this.u16();
    if (length < min) fail("malformed", `${what} is too short`);
    if (length > max) fail("too_large", `${what} is over ${max} bytes`);
    return this.#take(length, what);
  }

  text(min: number, max: number, what: string): string {
    const length = this.u16();
    if (length < min) fail("malformed", `${what} is empty`);
    if (length > max) fail("too_large", `${what} is over ${max} bytes`);
    let text: string;
    try {
      text = decoder.decode(this.#take(length, what));
    } catch {
      fail("malformed", `${what} is not UTF-8`);
    }
    if (UNSAFE_TEXT.test(text)) fail("malformed", `${what} holds a control character`);
    return text;
  }

  /** The bytes read so far. */
  before(): Uint8Array {
    return copy(this.#bytes.subarray(0, this.#at));
  }

  end(): void {
    if (this.#at !== this.#bytes.length) fail("malformed", "bytes left over");
  }
}
