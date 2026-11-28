// What F-557's Simulator check prints when your picture didn't load at the protected address
// (#878): the front's requests, each with its status and time, and the app's reasons from its
// log, which CI makes public. The check only prints them when a read fails there, so how they are
// kept, written and gathered is proven here.

import { createServer, request, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeFrontRequests,
  pictureFailure,
  pictureReasons,
  trackAnswer,
  type FrontRequest,
  type PictureFailureReads,
} from "../simulator/harness.ts";
import { SENT_PICTURE_LINES } from "../src/presentation/sent-files.ts";

const SOURCE = "media://inbound/shot---0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0.png";
const TICKET = ["v1", "c2NvcGU", "c2lnbmF0dXJl"].join(".");
const ROUTE = "/__openclaw__/assistant-media";
/** A session key in the gateway's form. Made up. */
const SESSION = "agent:pip:check";
const asked = (query: Record<string, string>, more: Partial<FrontRequest>): FrontRequest => ({
  method: "GET",
  url: `${ROUTE}?${new URLSearchParams(query)}`,
  authorization: undefined,
  authorizations: 0,
  cookie: undefined,
  at: 0,
  ...more,
});

describe("F-557: the protected front's log of a picture's read", () => {
  it("F-557: names each request's route, picture, status and time, and never a path or a query", () => {
    const requests = [
      asked(
        { meta: "1", source: SOURCE, sessionKey: "agent:pip:check" },
        { at: 1_200, status: 200, ms: 340, ended: "sent" },
      ),
      asked(
        { source: SOURCE, sessionKey: "agent:pip:check", mediaTicket: TICKET },
        { at: 1_600, ms: 30_004, ended: "closed" },
      ),
      asked(
        { meta: "1", source: "media://inbound/moved---1a2b.png" },
        { at: 1_250, status: 302, ms: 3, ended: "sent" },
      ),
      asked(
        { source: SOURCE, mediaTicket: TICKET },
        { at: 2_000, status: 200, ms: 90, ended: "closed" },
      ),
      asked({ source: SOURCE, mediaTicket: TICKET }, { at: 31_000 }),
      { ...asked({}, { at: 400, status: 404, ms: 2, ended: "sent" }), url: "/elsewhere" },
      // A picture that isn't one of F-557's own, by a name that could be anyone's.
      asked(
        { meta: "1", source: "media://inbound/agent-pip-check---1a2b.png" },
        { at: 2_500, status: 200, ms: 5, ended: "sent" },
      ),
      // Clawtrate's outgoing media route, whose path holds the task's session key; a path that
      // starts as the media route's; and an address that isn't one, with a method Node allows.
      {
        ...asked({}, { at: 3_000, status: 404, ms: 1, ended: "sent" }),
        url: `/api/chat/media/outgoing/${encodeURIComponent(SESSION)}/a1/full?mediaTicket=${TICKET}`,
      },
      {
        ...asked({}, { at: 3_100, status: 404, ms: 1, ended: "sent" }),
        url: `${ROUTE}/${SESSION}?source=${encodeURIComponent(SOURCE)}`,
      },
      {
        ...asked({}, { at: 3_200, status: 400, ms: 1, ended: "sent" }),
        method: "M-SEARCH",
        url: `http://[${SESSION}/`,
      },
    ];
    const log = describeFrontRequests(requests);
    expect(log.split("\n")).toEqual([
      "+1.2 s GET ticket for shot -> 200 in 340 ms",
      "+1.6 s GET media for shot -> no answer: closed after 30004 ms",
      "+1.3 s GET ticket for moved -> 302 in 3 ms",
      "+2.0 s GET media for shot -> 200, cut off: closed after 90 ms",
      "+31.0 s GET media for shot -> no answer yet",
      "+0.4 s GET elsewhere -> 404 in 2 ms",
      "+2.5 s GET ticket -> 200 in 5 ms",
      "+3.0 s GET elsewhere -> 404 in 1 ms",
      "+3.1 s GET elsewhere -> 404 in 1 ms",
      "+3.2 s other elsewhere -> 400 in 1 ms",
    ]);
    // No path, query, ticket, task or picture reference: the log is public in CI.
    for (const secret of [
      TICKET,
      "agent",
      "pip",
      "check",
      "0b1c2d3e",
      "mediaTicket",
      "sessionKey",
      "/",
      "?",
      "%",
      "__openclaw__",
    ])
      expect(log).not.toContain(secret);
    expect(describeFrontRequests([])).toBe("(no requests)");
  });
});

describe("F-557: the protected front keeps each answer's end", () => {
  let server: Server | null = null;
  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  /** A server that keeps each request's end, and answers `/slow` only after `wait` ms. */
  async function front(wait: number) {
    const requests: FrontRequest[] = [];
    const opened = Date.now();
    server = createServer((req, res) => {
      const each = asked({}, { url: req.url ?? "", at: Date.now() - opened });
      requests.push(each);
      trackAnswer(each, res, opened);
      if (req.url === "/slow")
        setTimeout(() => {
          if (!res.destroyed) res.writeHead(200).end("late");
        }, wait).unref();
      else res.writeHead(201).end("ok");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    return { requests, port };
  }

  const get = (port: number, path: string, abortAfter?: number) =>
    new Promise<void>((resolve) => {
      const req = request({ host: "127.0.0.1", port, path }, (res) => {
        res.resume();
        res.on("end", resolve);
      });
      req.on("error", () => resolve());
      req.end();
      if (abortAfter !== undefined) setTimeout(() => req.destroy(), abortAfter);
    });

  it("F-557: an answer sent whole keeps its status and how long it took", async () => {
    const { requests, port } = await front(150);
    await get(port, "/slow");
    await get(port, "/quick");
    expect(requests.map(({ url, status, ended }) => ({ url, status, ended }))).toEqual([
      { url: "/slow", status: 200, ended: "sent" },
      { url: "/quick", status: 201, ended: "sent" },
    ]);
    expect(requests[0]!.ms).toBeGreaterThanOrEqual(140);
  });

  it("F-557: a connection closed before any answer keeps no status, and when it closed", async () => {
    const { requests, port } = await front(5_000);
    await get(port, "/slow", 100);
    await expect.poll(() => requests[0]?.ended, { timeout: 2_000 }).toBe("closed");
    expect(requests[0]!.status).toBeUndefined();
    expect(requests[0]!.ms).toBeGreaterThanOrEqual(90);
    expect(requests[0]!.ms).toBeLessThan(4_000);
  });
});

describe("F-557: the app's reasons, from its log", () => {
  it("F-557: keeps only lines that end with exactly the app's record, and only the record", () => {
    const at =
      "2026-11-28 10:00:00.123 E  Clawtrate[4021:7f1a] [com.facebook.react.log:javascript]";
    const log = [
      `${at} [picture] reason=too-slow`,
      `${at} [picture] reason=gateway-answered status=503`,
      "[picture] reason=parts-missing",
      // The app's old line, and any other line holding the marker, whatever it carries.
      `${at} [picture] A sent picture didn't load: Bearer tok-4f1c9a`,
      `${at} [picture] reason=too-slow https://gateway.example/?mediaTicket=${TICKET}`,
      `${at} [picture] reason=too-slow status=503 ${SESSION}`,
      `${at} [picture] reason=agent:pip:check`,
      `${at} [picture] reason=no-such-reason`,
      `${at} [picture] reason=gateway-answered status=5031`,
      `${at} [picture] reason=gateway-answered status=abc`,
      `${at} [picture]  reason=too-slow`,
      `${at} x[picture] reason=too-slow`,
      `${at} [picture] reason=too-slow\u0000/private/var/mobile`,
      `${at} [core] could not start: ${SESSION}`,
    ].join("\n");
    expect(pictureReasons(log)).toEqual([
      "[picture] reason=too-slow",
      "[picture] reason=gateway-answered status=503",
      "[picture] reason=parts-missing",
    ]);
    expect(pictureReasons("")).toEqual([]);
  });
});

describe("F-557: what explains a failure never takes Maestro's place", () => {
  const MAESTRO = 'Steps "picture-far" failed: sent-picture not found';
  const FAILED_SCREEN = `{"text":"shot.png, 1 KB. ${SENT_PICTURE_LINES.failed}"}`;
  const LOG = "2026-11-28 E  Clawtrate[1:2] [picture] reason=too-slow";
  const FRONT = [
    asked(
      { meta: "1", source: SOURCE, sessionKey: SESSION },
      { at: 1_000, status: 200, ms: 4, ended: "sent" },
    ),
  ];
  const reads = (more: Partial<PictureFailureReads>): PictureFailureReads => ({
    screen: async () => FAILED_SCREEN,
    front: () => describeFrontRequests(FRONT),
    log: () => LOG,
    ...more,
  });
  const never = () => new Promise<never>(() => {});
  const printed = () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    return { text: () => spy.mock.calls.map((call) => call.join(" ")).join("\n"), spy };
  };
  afterEach(() => vi.restoreAllMocks());

  it("F-557: with the line on screen, the front's requests and the app's reason join Maestro's failure", async () => {
    const out = printed();
    const maestro = new Error(MAESTRO);
    const thrown = (await pictureFailure(maestro, reads({}))) as Error;
    expect(thrown.cause).toBe(maestro);
    expect(thrown.message.split("\n")).toEqual([
      MAESTRO,
      "The protected front's requests:",
      "+1.0 s GET ticket for shot -> 200 in 4 ms",
      "The app's reason:",
      "[picture] reason=too-slow",
    ]);
    expect(out.text()).toContain("+1.0 s GET ticket for shot -> 200 in 4 ms");
  });

  it("F-557: a description that throws is noted, and the app's reason and Maestro's failure stand", async () => {
    printed();
    const maestro = new Error(MAESTRO);
    const thrown = (await pictureFailure(
      maestro,
      reads({
        front: () => {
          throw new Error(`Invalid URL /api/chat/media/outgoing/${SESSION}`);
        },
      }),
    )) as Error;
    expect(thrown.cause).toBe(maestro);
    expect(thrown.message.split("\n")).toEqual([
      MAESTRO,
      "The protected front's requests:",
      "(they couldn't be described: it threw)",
      "The app's reason:",
      "[picture] reason=too-slow",
    ]);
    expect(thrown.message).not.toContain(SESSION);
  });

  it(
    "F-557: a screen that can't be read, or doesn't answer, still prints the front's requests, and Maestro's failure is thrown as it was",
    { timeout: 2_000 },
    async () => {
      for (const screen of [async () => Promise.reject(new Error("driver stopped")), never]) {
        const out = printed();
        const maestro = new Error(MAESTRO);
        expect(await pictureFailure(maestro, reads({ screen }), 50)).toBe(maestro);
        expect(out.text()).toContain(
          "The protected front's requests:\n+1.0 s GET ticket for shot -> 200 in 4 ms",
        );
        expect(out.text()).toContain("[picture] reason=too-slow");
        expect(out.text()).not.toContain("driver stopped");
        vi.restoreAllMocks();
      }
    },
  );

  it(
    "F-557: an app log that can't be read, or doesn't answer, is noted, and the front's requests and Maestro's failure stand",
    { timeout: 2_000 },
    async () => {
      for (const [log, note] of [
        [
          () => {
            throw new Error("log show: /private/var/mobile");
          },
          "(the app's log couldn't be read: it threw)",
        ],
        [never, "(the app's log couldn't be read: it timed out)"],
      ] as const) {
        printed();
        const maestro = new Error(MAESTRO);
        const thrown = (await pictureFailure(maestro, reads({ log }), 50)) as Error;
        expect(thrown.cause).toBe(maestro);
        expect(thrown.message.split("\n")).toEqual([
          MAESTRO,
          "The protected front's requests:",
          "+1.0 s GET ticket for shot -> 200 in 4 ms",
          "The app's reason:",
          note,
        ]);
        vi.restoreAllMocks();
      }
    },
  );

  it("F-557: a screen that shows another failure leaves Maestro's failure as it was, and prints nothing", async () => {
    const out = printed();
    const maestro = new Error(MAESTRO);
    expect(await pictureFailure(maestro, reads({ screen: async () => "{}" }))).toBe(maestro);
    expect(out.spy).not.toHaveBeenCalled();
  });
});
