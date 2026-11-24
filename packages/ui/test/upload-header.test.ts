// What an upload's header says before it is decoded (AvatarPicker.tsx): a
// GIF's logical screen counts only once every frame is found inside it.
import { describe, expect, it } from "vitest";
import { gifSize, imageHeader } from "../src/bots/AvatarPicker.tsx";

const le16 = (n: number) => [n & 255, (n >> 8) & 255];
/** A GIF with a screen and frames, each frame's image data a stand-in two bytes long. */
function gif(
  screen: [number, number],
  frames: Array<[number, number, number, number]>,
  extra: number[] = [],
) {
  const bytes = [
    ...[..."GIF89a"].map((c) => c.charCodeAt(0)),
    ...le16(screen[0]),
    ...le16(screen[1]),
    0x80,
    0,
    0,
  ];
  bytes.push(0, 0, 0, 255, 255, 255); // a global table of two colours
  // A graphic control extension, with its one sub-block.
  bytes.push(0x21, 0xf9, 4, 0, 0, 0, 0, 0);
  for (const [left, top, w, h] of frames)
    bytes.push(0x2c, ...le16(left), ...le16(top), ...le16(w), ...le16(h), 0, 2, 2, 0x44, 0x01, 0);
  bytes.push(...extra, 0x3b);
  return new Uint8Array(bytes);
}

describe("a GIF's size before decoding", () => {
  it("is its logical screen when every frame is inside it", () => {
    expect(gifSize(gif([1, 1], [[0, 0, 1, 1]]))).toEqual({ width: 1, height: 1 });
    expect(
      gifSize(
        gif(
          [4, 4],
          [
            [0, 0, 4, 4],
            [1, 1, 2, 2],
          ],
        ),
      ),
    ).toEqual({ width: 4, height: 4 });
    expect(imageHeader(gif([3, 2], [[0, 0, 3, 2]]))).toEqual({ width: 3, height: 2 });
  });

  it("refuses a frame larger than the screen, outside it, or empty, and a screen of zero", () => {
    expect(gifSize(gif([1, 1], [[0, 0, 4, 4]]))).toBeNull();
    expect(gifSize(gif([4, 4], [[3, 0, 2, 2]]))).toBeNull();
    expect(gifSize(gif([4, 4], [[0, 0, 0, 2]]))).toBeNull();
    expect(gifSize(gif([0, 4], [[0, 0, 1, 1]]))).toBeNull();
  });

  it("refuses a GIF cut short or holding a block GIF doesn't have", () => {
    const whole = gif([2, 2], [[0, 0, 2, 2]]);
    expect(gifSize(whole.subarray(0, whole.length - 1))).toBeNull();
    expect(gifSize(whole.subarray(0, 30))).toBeNull();
    expect(gifSize(gif([2, 2], [[0, 0, 2, 2]], [0x99]))).toBeNull();
  });
});

describe("a JPEG's size before decoding", () => {
  /** A JPEG's start, an APP1 block of metadata of the size given, then a frame header. */
  function jpeg(metadata: number, width: number, height: number) {
    const bytes: number[] = [0xff, 0xd8];
    for (let left = metadata; left > 0;) {
      const size = Math.min(left, 65_533);
      bytes.push(0xff, 0xe1, (size + 2) >> 8, (size + 2) & 255, ...new Array(size).fill(0));
      left -= size;
    }
    bytes.push(0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3);
    bytes.push(...new Array(9).fill(0), 0xff, 0xd9);
    return new Uint8Array(bytes);
  }

  it("is found after any amount of metadata, given the whole file", () => {
    const whole = jpeg(300 * 1024, 48, 32);
    expect(imageHeader(whole)).toEqual({ width: 48, height: 32 });
    // The first 256 KiB alone don't reach the frame header: the picker then reads the whole file.
    expect(imageHeader(whole.subarray(0, 256 * 1024))).toBeNull();
  });
});
