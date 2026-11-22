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
