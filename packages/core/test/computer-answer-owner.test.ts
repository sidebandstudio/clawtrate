// Give back control and answer, through a viewer's bridge session: the answer belongs to the
// hand-back that chose it. A viewer that leaves the Computer tab, or goes away, before the answer
// was sent takes it with it, while the release goes on; the question stays open for another
// viewer of the same task.

import { describe, expect, it, vi } from "vitest";
import { createBridgeSession } from "../src/bridge.ts";
import type { ComputerViews } from "../src/computer.ts";
import type { FakeGateway } from "./fake-gateway.ts";
import { grantingGateway, KEY, openTask, questionRecord } from "./client-harness.ts";
import { deferred, helloOk, until } from "./fake-gateway.ts";

const GEN = "d".repeat(32);
const TAB = "TAB0000000000000000000000000000B";
const ANSWER = { questionId: "ask_1", itemId: "color", option: 0 };

/** A gateway with the computer plugin; `release` answers the hand-back when the test says. */
function computerGateway(release: () => unknown): FakeGateway {
  const gateway = grantingGateway();
  gateway.connectReply = (params) => {
    const { scopes } = params as { scopes: string[] };
    return {
      ok: true,
      payload: {
        ...helloOk(scopes, "device-token"),
        features: { methods: ["clawtrate-computer.tabs"], events: [] },
      },
    };
  };
  gateway.handlers["clawtrate-computer.tabs"] = () => ({
    agentId: "otto",
    profile: "bot-otto",
    browser: "running",
    tabs: [{ targetId: TAB, url: "http://127.0.0.1:1/", title: "Disk", lease: null }],
  });
  gateway.handlers["clawtrate-computer.control.take"] = () => ({
    state: "granted",
    generation: GEN,
    renewWithinMs: 20_000,
    targetId: TAB,
    guarantee: [],
  });
  gateway.handlers["clawtrate-computer.control.release"] = release;
  // The answer reads the question at its place before it is sent.
  gateway.handlers["question.list"] = () => ({ questions: [questionRecord("ask_1", "run-1")] });
  gateway.handlers["question.resolve"] = () => ({ status: "answered" });
  return gateway;
}

const released = { state: "released", generation: GEN, targetId: TAB };

async function inControl(gateway: FakeGateway, held?: readonly string[]) {
  const { client, transcript } = await openTask(held ? { gateway, held } : { gateway });
  gateway.emit("question.requested", questionRecord("ask_1", "run-1"));
  await until(() => transcript().questions.length === 1);
  // The person's viewer, and another window with the same task open.
  const viewer = createBridgeSession(client);
  const other = createBridgeSession(client);
  await other.apply({ type: "openSession", key: KEY });
  await viewer.apply({ type: "openSession", key: KEY });
  await viewer.apply({ type: "computerShow", key: KEY });
  const id = viewer.computerViewer()!;
  await until(() => client.state.computer?.panes[id]?.availability === "ready");
  await viewer.apply({ type: "computerTake" });
  await until(() => client.state.computer?.panes[id]?.control.status === "granted");
  return { client, transcript, viewer, other };
}

const goes = {
  leaves: (viewer: ReturnType<typeof createBridgeSession>) =>
    viewer.apply({ type: "computerLeave" }),
  "goes away": async (viewer: ReturnType<typeof createBridgeSession>) => viewer.dispose(),
};

describe("Give back control and answer: the answer is the viewer's that chose it", () => {
  for (const [what, go] of Object.entries(goes)) {
    it(`F-145: a viewer that ${what} before the release is confirmed sends no answer; the release goes on and the question stays open`, async () => {
      const release = deferred<unknown>();
      const gateway = computerGateway(() => release.promise);
      const { client, transcript, viewer, other } = await inControl(gateway);
      // The engine's own step once the release is confirmed: an answer would start there.
      const confirmed = vi.spyOn(
        (client as unknown as { computer: ComputerViews }).computer as unknown as {
          confirmed: (...args: unknown[]) => void;
        },
        "confirmed",
      );
      try {
        await viewer.apply({ type: "computerRelease", answer: ANSWER });
        await until(() => gateway.calls("clawtrate-computer.control.release").length === 1);
        await go(viewer);
        release.resolve(released);
        await until(() => confirmed.mock.calls.length === 1);
        // An answer started would be submitting until its request ended.
        await until(() => transcript().questions[0]?.submitting === false);
        expect(gateway.calls("question.resolve")).toEqual([]);
        expect(transcript().questions[0]).toMatchObject({ status: "pending" });
      } finally {
        release.resolve(released);
        viewer.dispose();
        other.dispose();
        client.stop();
      }
    });

    it(`F-145: a viewer that ${what} while the answer reads the question sends no answer; the question stays open`, async () => {
      const gateway = computerGateway(() => released);
      const { client, transcript, viewer, other } = await inControl(gateway);
      const list = deferred<unknown>();
      const settle = () => list.resolve({ questions: [questionRecord("ask_1", "run-1")] });
      try {
        const listed = gateway.calls("question.list").length;
        gateway.handlers["question.list"] = () => list.promise;
        await viewer.apply({ type: "computerRelease", answer: ANSWER });
        await until(() => gateway.calls("question.list").length > listed);
        await go(viewer);
        settle();
        // The answer's attempt is over: withdrawn, or sent and answered.
        await until(() => transcript().questions[0]?.submitting === false);
        expect(gateway.calls("question.resolve")).toEqual([]);
        expect(transcript().questions[0]).toMatchObject({ status: "pending", submitting: false });
      } finally {
        settle();
        viewer.dispose();
        other.dispose();
        client.stop();
      }
    });

    it(`F-145: a viewer that ${what} while the answer waits for question access sends no answer; the question stays open`, async () => {
      const gateway = computerGateway(() => released);
      const wait = deferred<unknown>();
      gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-1" });
      gateway.handlers["device.scopes.waitUpgrade"] = () => wait.promise;
      const { client, transcript, viewer, other } = await inControl(gateway, [
        "operator.read",
        "operator.write",
      ]);
      const approve = () =>
        wait.resolve({
          status: "approved",
          requestId: "up-1",
          deviceToken: "rotated",
          scopes: ["operator.read", "operator.write", "operator.questions"],
        });
      try {
        await viewer.apply({ type: "computerRelease", answer: ANSWER });
        await until(() => client.state.connection.upgrade.status === "pending");
        await go(viewer);
        approve();
        // Access arrived, and the answer's attempt, if any was left, is over.
        await until(
          () =>
            client.state.connection.scopes.includes("operator.questions") &&
            transcript().questions[0]?.submitting === false,
        );
        expect(gateway.calls("question.resolve")).toEqual([]);
        expect(transcript().questions[0]).toMatchObject({ status: "pending", submitting: false });
      } finally {
        approve();
        viewer.dispose();
        other.dispose();
        client.stop();
      }
    });
  }

  it("F-145: an answer arriving after the viewer leaves keeps the original release and the open question", async () => {
    const release = deferred<unknown>();
    const gateway = computerGateway(() => release.promise);
    const { client, transcript, viewer, other } = await inControl(gateway);
    const id = viewer.computerViewer()!;
    try {
      await viewer.apply({ type: "computerLeave" });
      await until(() => gateway.calls("clawtrate-computer.control.release").length === 1);
      await viewer.apply({ type: "computerRelease", answer: ANSWER });
      expect(client.state.computer?.panes[id]?.control.answerQueued).toBe(false);
      release.resolve(released);
      await until(() => client.state.computer?.panes[id]?.control.released === true);
      expect(gateway.calls("clawtrate-computer.control.release")).toHaveLength(1);
      expect(gateway.calls("question.resolve")).toEqual([]);
      expect(transcript().questions[0]?.status).toBe("pending");
    } finally {
      release.resolve(released);
      viewer.dispose();
      other.dispose();
      client.stop();
    }
  });

  it("F-145: a later hand-back retires the earlier answer waiting for the question", async () => {
    const nextRelease = deferred<unknown>();
    let releases = 0;
    const gateway = computerGateway(() => (++releases === 1 ? released : nextRelease.promise));
    const { client, transcript, viewer, other } = await inControl(gateway);
    const list = deferred<unknown>();
    const questions = { questions: [questionRecord("ask_1", "run-1")] };
    try {
      const listed = gateway.calls("question.list").length;
      gateway.handlers["question.list"] = () => list.promise;
      await viewer.apply({ type: "computerRelease", answer: ANSWER });
      await until(() => gateway.calls("question.list").length > listed);
      await viewer.apply({ type: "computerTake" });
      await until(
        () => client.state.computer?.panes[viewer.computerViewer()!]?.control.status === "granted",
      );
      await viewer.apply({ type: "computerRelease", answer: ANSWER });
      await until(() => releases === 2);
      await viewer.apply({ type: "computerLeave" });
      list.resolve(questions);
      nextRelease.resolve(released);
      await until(() => transcript().questions[0]?.submitting === false);
      expect(gateway.calls("question.resolve")).toEqual([]);
    } finally {
      list.resolve(questions);
      nextRelease.resolve(released);
      viewer.dispose();
      other.dispose();
      client.stop();
    }
  });

  for (const drop of [false, true]) {
    it(`F-145: ${drop ? "a dropped socket retires the answer waiting for access" : "the requested scope upgrade keeps the answer alive"}`, async () => {
      const gateway = computerGateway(() => released);
      const wait = deferred<unknown>();
      gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-1" });
      gateway.handlers["device.scopes.waitUpgrade"] = () => wait.promise;
      const { client, transcript, viewer, other } = await inControl(gateway, [
        "operator.read",
        "operator.write",
      ]);
      const approval = {
        status: "approved",
        requestId: "up-1",
        deviceToken: "rotated",
        scopes: ["operator.read", "operator.write", "operator.questions"],
      };
      try {
        await viewer.apply({ type: "computerRelease", answer: ANSWER });
        await until(
          () =>
            client.state.connection.upgrade.status === "pending" && client.pendingAccessWaiters > 0,
        );
        if (drop) gateway.dropAll();
        wait.resolve(approval);
        if (drop) {
          await until(
            () => client.pendingAccessWaiters === 0 && !transcript().questions[0]?.submitting,
          );
          expect(gateway.calls("question.resolve")).toEqual([]);
          expect(client.state.computer?.panes[viewer.computerViewer()!]?.control).toMatchObject({
            status: "none",
            outcome: "answer-failed",
          });
        } else {
          await until(() => gateway.calls("question.resolve").length === 1);
        }
      } finally {
        wait.resolve(approval);
        viewer.dispose();
        other.dispose();
        client.stop();
      }
    });
  }

  it("F-145: a viewer that stays sends the answer once the release is confirmed", async () => {
    const gateway = computerGateway(() => released);
    const { client, viewer, other } = await inControl(gateway);
    try {
      await viewer.apply({ type: "computerRelease", answer: ANSWER });
      await until(() => gateway.calls("question.resolve").length === 1);
      expect(gateway.calls("question.resolve")[0]).toMatchObject({ id: "ask_1" });
    } finally {
      viewer.dispose();
      other.dispose();
      client.stop();
    }
  });
});
