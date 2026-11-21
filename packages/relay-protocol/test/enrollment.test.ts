// Enrollment is committed only after the phone proves it is live (the confirm record), and the
// key the gate and the host see is a copy of the one the handshake authenticated.

import { describe, expect, it } from "vitest";
import { EnrollmentOffer, generateKeyPair, Initiator, Responder } from "../src/index.ts";
import { makePair, openPair, RELAY_ID, sends, settle, TestGate } from "./helpers.ts";

const SECRET = new Uint8Array(32).fill(9);

function phoneFor(gateKey: Uint8Array, staticKey = generateKeyPair(), enroll = true) {
  return new Initiator({
    relayId: RELAY_ID,
    connectorKey: gateKey,
    staticKey,
    ...(enroll ? { enroll: SECRET } : {}),
  });
}

describe("enrollment", () => {
  it("message 1 and message 2 change nothing; the confirm record and the host's commit do", () => {
    const pair = makePair();
    const [hs2] = sends(pair.connector.receive(pair.phone.start()));
    expect(pair.gate.checks).toBe(1);
    expect(pair.gate.enrolled).toEqual([]);
    expect(pair.gate.offer!.used).toBe(false);
    const [confirm] = sends(pair.phone.receive(hs2!));
    expect(pair.gate.enrolled).toEqual([]);
    const events = pair.connector.receive(confirm!);
    expect(events).toEqual([{ type: "admit", phoneKey: pair.phoneKey.publicKey, enroll: SECRET }]);
    expect(pair.gate.enrolled).toEqual([]);
    expect(pair.phone.receive(settle(pair.connector, pair.gate, events))).toEqual([
      { type: "open" },
    ]);
    expect(pair.gate.enrolled).toEqual([pair.phoneKey.publicKey]);
    expect(pair.gate.offer!.used).toBe(true);
  });

  it("a dropped handshake leaves the offer unspent and nothing pending", () => {
    const pair = makePair();
    const [hs2] = sends(pair.connector.receive(pair.phone.start()));
    // The relay drops message 2; the host times out and aborts.
    expect(pair.connector.abort()).toBe(false);
    expect(pair.connector.currentState).toBe("failed");
    expect(() => pair.connector.admit()).toThrow();
    expect(pair.gate.offer!.used).toBe(false);
    expect(pair.gate.enrolled).toEqual([]);
    // The phone, told nothing, gives up the same way.
    pair.phone.receive(hs2!);
    expect(pair.phone.abort()).toBe(false);
    // The same code still works for a fresh attempt.
    const retry = makePair();
    retry.gate.offer = pair.gate.offer;
    openPair({ ...retry, gate: retry.gate });
    expect(retry.gate.enrolled).toHaveLength(1);
  });

  it("an offer that expires between message 1 and the confirm record is refused at commit", () => {
    const pair = makePair();
    const [hs2] = sends(pair.connector.receive(pair.phone.start()));
    const [confirm] = sends(pair.phone.receive(hs2!));
    pair.gate.nowMs = pair.gate.offer!.expiresAtMs;
    const refusal = settle(pair.connector, pair.gate, pair.connector.receive(confirm!));
    expect(pair.connector.currentState).toBe("closed");
    expect(pair.phone.receive(refusal)).toEqual([
      { type: "refused", reason: "enrollment_refused" },
    ]);
    expect(pair.phone.currentState).toBe("closed");
    expect(pair.gate.enrolled).toEqual([]);
    expect(pair.gate.offer!.used).toBe(false);
  });

  it("of two phones confirming with one secret, only the first commit enrolls", () => {
    const gate = new TestGate();
    gate.offer = new EnrollmentOffer(SECRET, 60_000);
    const connectorKey = generateKeyPair();
    const ends = [0, 1].map(() => ({
      phone: phoneFor(connectorKey.publicKey),
      connector: new Responder({ relayId: RELAY_ID, staticKey: connectorKey, gate }),
    }));
    // Both pass the read-only check at message 1 and both confirm.
    const admits = ends.map(({ phone, connector }) => {
      const [hs2] = sends(connector.receive(phone.start()));
      const [confirm] = sends(phone.receive(hs2!));
      return connector.receive(confirm!);
    });
    expect(gate.checks).toBe(2);
    const results = ends.map(({ phone, connector }, i) =>
      phone.receive(settle(connector, gate, admits[i]!)),
    );
    expect(results).toEqual([
      [{ type: "open" }],
      [{ type: "refused", reason: "enrollment_refused" }],
    ]);
    expect(gate.enrolled).toHaveLength(1);
  });

  it("a failed commit admits nobody and spends nothing; the phone can try again", () => {
    const pair = makePair();
    pair.gate.failNextCommit = true;
    const [hs2] = sends(pair.connector.receive(pair.phone.start()));
    const [confirm] = sends(pair.phone.receive(hs2!));
    const events = pair.connector.receive(confirm!);
    expect(() => settle(pair.connector, pair.gate, events)).toThrow("allowlist write failed");
    // The host aborts on the error.
    pair.connector.abort();
    expect(pair.phone.currentState).toBe("confirming");
    expect(pair.gate.enrolled).toEqual([]);
    expect(pair.gate.offer!.used).toBe(false);

    const phone = phoneFor(pair.connectorKey.publicKey, pair.phoneKey);
    const connector = new Responder({
      relayId: RELAY_ID,
      staticKey: pair.connectorKey,
      gate: pair.gate,
    });
    openPair({ ...pair, phone, connector });
    expect(pair.gate.enrolled).toEqual([pair.phoneKey.publicKey]);
  });

  it("a phone removed from the allowlist before it confirms is refused at commit", () => {
    const pair = makePair({ enroll: false });
    pair.gate.enrolled.push(Uint8Array.from(pair.phoneKey.publicKey));
    const [hs2] = sends(pair.connector.receive(pair.phone.start()));
    const [confirm] = sends(pair.phone.receive(hs2!));
    pair.gate.enrolled.length = 0;
    const refusal = settle(pair.connector, pair.gate, pair.connector.receive(confirm!));
    expect(pair.phone.receive(refusal)).toEqual([{ type: "refused", reason: "not_enrolled" }]);
  });
});

describe("the authenticated phone key", () => {
  it("is copied to the gate, the admit event, the accessor and admit(), so no caller can change it", () => {
    const pair = makePair();
    const real = Uint8Array.from(pair.phoneKey.publicKey);
    const check = pair.gate.check.bind(pair.gate);
    pair.gate.check = (phoneKey, enroll) => {
      const answer = check(phoneKey, enroll);
      phoneKey.fill(0xaa);
      enroll?.fill(0xbb);
      return answer;
    };
    const [hs2] = sends(pair.connector.receive(pair.phone.start()));
    const [confirm] = sends(pair.phone.receive(hs2!));

    const accessor = pair.connector.phoneKey!;
    expect(accessor).toEqual(real);
    accessor.fill(0xcc);
    expect(pair.connector.phoneKey).toEqual(real);

    const [admit] = pair.connector.receive(confirm!);
    if (admit?.type !== "admit") throw new Error("No admit event.");
    expect(admit.phoneKey).toEqual(real);
    expect(admit.enroll).toEqual(SECRET);
    admit.phoneKey.fill(0xdd);
    pair.gate.enrolled.push(Uint8Array.from(real));
    const { frame, phoneKey } = pair.connector.admit();
    expect(phoneKey).toEqual(real);
    // The handshake finished with the authenticated key, so the phone opens.
    expect(pair.phone.receive(frame)).toEqual([{ type: "open" }]);
  });
});
