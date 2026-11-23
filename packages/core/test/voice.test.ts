import { describe, expect, it } from "vitest";
import { readVoice, setVoice } from "../src/voice.ts";

describe("the plain voice setting", () => {
  it("asks nothing of a gateway whose hello does not list the plugin", async () => {
    const asked: string[] = [];
    const request = async (method: string) => void asked.push(method);
    expect(await readVoice(request, false)).toEqual({ plugin: false });
    expect(asked).toEqual([]);
  });

  it("shows only what the plugin answered", async () => {
    const answer = { plain: false, reachesBots: true, guide: "x" };
    const calls: unknown[] = [];
    const request = async (method: string, params: unknown) => {
      calls.push([method, params]);
      return answer;
    };
    expect(await readVoice(request, true)).toEqual({
      plugin: true,
      plain: false,
      reachesBots: true,
    });
    expect(await setVoice(request, true)).toMatchObject({ plain: false });
    expect(calls).toEqual([
      ["clawtrate-voice.get", {}],
      ["clawtrate-voice.set", { plain: true }],
    ]);
    await expect(readVoice(async () => ({ plain: "yes" }), true)).rejects.toThrow(
      /did not say whether/,
    );
  });
});
