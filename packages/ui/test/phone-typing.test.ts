// The phone's "Type into the page" field (`phone-typing.ts`): each part goes once, in order, one
// call at a time; text the host refused is held apart and goes again only when asked, ahead of
// anything typed after it.

import { describe, expect, it } from "vitest";
import {
  answered,
  emptyTyping,
  fieldText,
  nextCall,
  sendAgain,
  typedInto,
} from "../src/work/phone-typing.ts";

describe("the phone's typed field", () => {
  it("sends each part once, in order, one call at a time; the field shows only what was taken or is on its way", () => {
    let t = typedInto(emptyTyping, "a");
    const first = nextCall(t)!;
    expect(first.text).toBe("a");
    t = typedInto(first.typing, "ab");
    // The first call's answer isn't back: nothing else goes.
    expect(nextCall(t)).toBeNull();
    expect(fieldText(t)).toBe("a");
    t = answered(t, true);
    const second = nextCall(t)!;
    expect(second.text).toBe("b");
    t = answered(second.typing, true);
    expect(t).toEqual({ accepted: "ab", flight: "", unsent: "", held: false });
  });

  it("a refusal keeps the text out of the field, held as not sent ahead of what follows; sent again, it goes once, then the rest", () => {
    let t = typedInto(emptyTyping, "r");
    const call = nextCall(t)!;
    t = answered(typedInto(call.typing, "rejected"), false);
    expect(t).toMatchObject({ accepted: "", unsent: "rejected", held: true });
    expect(fieldText(t)).toBe("");
    // Typed while held: after it, and nothing goes until asked.
    t = typedInto(t, "!");
    expect(t.unsent).toBe("rejected!");
    expect(nextCall(t)).toBeNull();
    const again = nextCall(sendAgain(t))!;
    expect(again.text).toBe("rejected!");
    t = answered(again.typing, true);
    expect(t).toEqual({ accepted: "rejected!", flight: "", unsent: "", held: false });
    expect(nextCall(t)).toBeNull();
  });

  it("a deletion of what went is not taken back, and one paste keeps at most one call's 2,000 characters", () => {
    const t = typedInto(emptyTyping, "x".repeat(2500));
    expect(t.unsent).toHaveLength(2000);
    const call = nextCall(t)!;
    expect(call.text).toHaveLength(2000);
    expect(call.typing.unsent).toBe("");
    const done = answered(call.typing, true);
    expect(typedInto(done, "x".repeat(10))).toBe(done);
  });
});
