// What `ssh` writes on each failure, recorded from the clients the research ran
// (docs/research/setup-flow.md, section 7) with made-up names, and how each is
// told apart. Nothing of the output is carried into a result.

import { describe, expect, it } from "vitest";

import {
  classifySshFailure,
  failureFromFacts,
  ForwardOutput,
  MAX_PENDING_LINE,
  forwardListening,
  parseSshVersion,
  readProbeLines,
} from "../../src/main/ssh/ssh-output.ts";
import { failureNote, type Route } from "../../src/main/ssh/transport.ts";
import { parseDestination, routeAlias } from "../../src/main/ssh/destination.ts";

const FP = "SHA256:dv91cEANbiDdpyNeOeGBAXjZ69LPTU9DqQRjRioGigA";

/** Recorded error output, by failure and client. */
const RECORDED: Array<[string, string, string, ReturnType<typeof classifySshFailure>]> = [
  [
    "macOS",
    "refused",
    "ssh: connect to host 127.0.0.1 port 1: Connection refused\r\n",
    { kind: "unreachable", cause: "connection refused", exit: 255 },
  ],
  [
    "Linux",
    "refused",
    "ssh: connect to host 127.0.0.1 port 1: Connection refused\n",
    { kind: "unreachable", cause: "connection refused", exit: 255 },
  ],
  [
    "Windows",
    "refused",
    "banner exchange: Connection to UNKNOWN port -1: Connection refused\r\n",
    { kind: "unreachable", cause: "connection refused", exit: 255 },
  ],
  [
    "macOS",
    "no such name",
    "ssh: Could not resolve hostname nonexistent.invalid: nodename nor servname provided, or not known\n",
    { kind: "unreachable", cause: "no such name", exit: 255 },
  ],
  [
    "Linux",
    "no such name",
    "ssh: Could not resolve hostname nonexistent.invalid: Name or service not known\n",
    { kind: "unreachable", cause: "no such name", exit: 255 },
  ],
  [
    "Windows",
    "no such name",
    "ssh: Could not resolve hostname nonexistent.invalid: No such host is known. \r\n",
    { kind: "unreachable", cause: "no such name", exit: 255 },
  ],
  [
    "macOS",
    "no answer",
    "ssh: connect to host 192.0.2.1 port 22: Operation timed out\n",
    { kind: "unreachable", cause: "timed out", exit: 255 },
  ],
  [
    "Linux",
    "no answer",
    "ssh: connect to host 192.0.2.1 port 22: Connection timed out\n",
    { kind: "unreachable", cause: "timed out", exit: 255 },
  ],
  [
    "Linux",
    "no route",
    "ssh: connect to host 192.0.2.1 port 22: No route to host\n",
    { kind: "unreachable", cause: "network unreachable", exit: 255 },
  ],
  [
    "Linux",
    "network down",
    "ssh: connect to host 192.0.2.1 port 22: Network is unreachable\n",
    { kind: "unreachable", cause: "network unreachable", exit: 255 },
  ],
  [
    "macOS",
    "sign-in",
    "you@127.0.0.1: Permission denied (publickey).\n",
    { kind: "sign-in-refused", exit: 255 },
  ],
  [
    "Linux",
    "sign-in",
    "you@devbox.example: Permission denied (publickey,password).\n",
    { kind: "sign-in-refused", exit: 255 },
  ],
  [
    "Windows",
    "sign-in",
    "git@devbox.example: Permission denied (publickey).\r\n",
    { kind: "sign-in-refused", exit: 255 },
  ],
  [
    "macOS",
    "host key unknown",
    "No ED25519 host key is known for [127.0.0.1]:54249 and you have requested strict checking.\nHost key verification failed.\n",
    { kind: "host-key-unknown", exit: 255 },
  ],
  [
    "Windows",
    "host key unknown",
    "No ED25519 host key is known for devbox.example and you have requested strict checking.\r\nHost key verification failed.\r\n",
    { kind: "host-key-unknown", exit: 255 },
  ],
  [
    "Linux",
    "host key changed",
    [
      "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
      "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @",
      "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
      "IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!",
      `The fingerprint for the ED25519 key sent by the remote host is\n${FP}.`,
      "Host key for clawtrate-route-1 has changed and you have requested strict checking.",
      "Host key verification failed.",
      "",
    ].join("\n"),
    { kind: "host-key-changed", exit: 255 },
  ],
  [
    "macOS",
    "forward dropped",
    "Connection to 127.0.0.1 closed by remote host.\n",
    { kind: "dropped", exit: 255 },
  ],
  [
    "Linux",
    "forward silent",
    "Timeout, server 127.0.0.1 not responding.\n",
    { kind: "dropped", exit: 255 },
  ],
  [
    "macOS",
    "port taken",
    "bind [127.0.0.1]:54000: Address already in use\nchannel_setup_fwd_listener_tcpip: cannot listen to port: 54000\nCould not request local forwarding.\n",
    { kind: "local-port-taken", exit: 255 },
  ],
  [
    "macOS",
    "a forward to a closed port, then a drop",
    "channel 1: open failed: connect failed: Connection refused\nConnection to 127.0.0.1 closed by remote host.\n",
    { kind: "dropped", exit: 255 },
  ],
  [
    "Linux",
    "a forward to a closed port, then silence",
    "channel 2: open failed: connect failed: Connection refused\nTimeout, server 127.0.0.1 not responding.\n",
    { kind: "dropped", exit: 255 },
  ],
  [
    "any",
    "something else",
    "kex_exchange_identification: read: Connection reset by peer\n",
    { kind: "dropped", exit: 255 },
  ],
  ["any", "unknown", "something nobody has seen\n", { kind: "ssh-stopped", exit: 255 }],
  ["any", "another exit", "Permission denied (publickey).\n", { kind: "ssh-stopped", exit: 1 }],
];

describe("ssh's three failures, told apart", () => {
  it.each(RECORDED)("%s, %s", (_client, _case, stderr, expected) => {
    const exit = "exit" in expected && expected.exit !== null ? expected.exit : 255;
    expect(classifySshFailure(stderr, exit)).toEqual(expected);
  });

  it("ignores -v's debug lines, which name causes of their own", () => {
    const verbose = [
      "debug1: connect to address 127.0.0.1 port 22: Connection refused",
      "debug1: Authentications that can continue: publickey",
      "you@127.0.0.1: Permission denied (publickey).",
    ].join("\r\n");
    expect(classifySshFailure(verbose, 255)).toEqual({ kind: "sign-in-refused", exit: 255 });
  });

  const route = {
    id: "1",
    alias: routeAlias("1", "you@[devbox.example]:22"),
    endpoint: "you@[devbox.example]:22",
    generation: "g",
    account: "you@devbox.example",
    accountWithPort: "you@devbox.example, port 22",
    target: {
      ok: true,
      destination: parseDestination("devbox")!,
      name: "devbox",
      hostName: "devbox.example",
      user: "you",
      port: 22,
      identityFiles: [],
      identitiesOnly: null,
      certificateFiles: [],
      identityAgent: "world",
      pubkeyAuthentication: null,
    },
  } satisfies Route;

  it("says each in fixed copy, with only the category's words and the exit status", () => {
    expect(
      failureNote({ kind: "unreachable", cause: "connection refused", exit: 255 }, route, "darwin"),
    ).toEqual({
      title: "Can't reach you@devbox.example",
      sentence: "Nothing answered at devbox.example, port 22 (connection refused).",
      next: "Check the name and that the computer is on.",
    });
    expect(failureNote({ kind: "sign-in-refused", exit: 255 }, route, "linux")).toEqual({
      title: "you@devbox.example didn't accept your key",
      sentence: "The SSH sign-in for you@devbox.example was refused.",
      next: "Check that your key is on that computer. A key with a passphrase has to be in your SSH agent first.",
    });
    expect(failureNote({ kind: "sign-in-refused", exit: 255 }, route, "win32").next).toBe(
      "Check that your key is on that computer. A key with a passphrase has to be in your SSH agent first. Key-agent sign-in has not been verified on Windows.",
    );
    expect(failureNote({ kind: "host-key-changed", exit: 255 }, route, "darwin").title).toBe(
      "devbox's key has changed",
    );
    expect(failureNote({ kind: "ssh-stopped", exit: 255 }, route, "darwin")).toEqual({
      title: "ssh stopped",
      sentence: "ssh stopped (exit 255).",
      next: null,
    });
  });
});

describe("the -v lines a host-key probe reads", () => {
  it("reads the server's key, the match and the file and line, with either line end", () => {
    for (const end of ["\n", "\r\n"]) {
      const stderr = [
        "OpenSSH_9.9p2, LibreSSL 3.3.6",
        "debug1: Reading configuration data /srv/app/route-1.lookup.conf",
        `debug1: Server host key: ssh-ed25519 ${FP}`,
        "debug1: Host '[127.0.0.1]:54249' is known and matches the ED25519 host key.",
        "debug1: Found key in /srv/person/.ssh/known_hosts:2",
        "debug1: Authentications that can continue: publickey",
        "",
      ].join(end);
      expect(readProbeLines(stderr)).toEqual({
        serverKey: { type: "ssh-ed25519", fingerprint: FP },
        matches: true,
        foundIn: { file: "/srv/person/.ssh/known_hosts", line: 2 },
      });
    }
  });

  it("reads a Windows path", () => {
    expect(
      readProbeLines("debug1: Found key in C:\\ProgramData\\person\\known_hosts:7\r\n").foundIn,
    ).toEqual({
      file: "C:\\ProgramData\\person\\known_hosts",
      line: 7,
    });
  });

  it("finds nothing in lines of another shape", () => {
    expect(
      readProbeLines(
        "Server host key: ssh-ed25519 SHA256:x\ndebug1: Host 'x' is known and matches\ndebug1: Found key in :x\n",
      ),
    ).toEqual({ serverKey: null, matches: false, foundIn: null });
  });

  it("knows when the forward listens", () => {
    expect(
      forwardListening("debug1: Local forwarding listening on 127.0.0.1 port 54000.\r", 54000),
    ).toBe(true);
    expect(
      forwardListening("debug1: Local forwarding listening on 127.0.0.1 port 54001.", 54000),
    ).toBe(false);
  });
});

describe("the ssh client's version", () => {
  it("reads the clients the research ran", () => {
    expect(parseSshVersion("OpenSSH_9.9p2, LibreSSL 3.3.6\n")).toEqual({
      windows: false,
      major: 9,
      minor: 9,
    });
    expect(
      parseSshVersion("OpenSSH_9.6p1 Ubuntu-3ubuntu13.5, OpenSSL 3.0.13 30 Jan 2024\n"),
    ).toEqual({
      windows: false,
      major: 9,
      minor: 6,
    });
    expect(parseSshVersion("OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2\r\n")).toEqual({
      windows: true,
      major: 9,
      minor: 5,
    });
    expect(parseSshVersion("OpenSSH_for_Windows_8.1p1, LibreSSL 3.0.2\r\n")).toEqual({
      windows: true,
      major: 8,
      minor: 1,
    });
    expect(parseSshVersion("Sun_SSH_1.1\n")).toBeNull();
  });
});

describe("a running forward's error output", () => {
  it("is read into facts as it arrives, across chunk boundaries, and holds no line once read", () => {
    const output = new ForwardOutput(54000);
    output.push("debug1: Local forwarding listen");
    expect(output.listening).toBe(false);
    output.push(
      "ing on 127.0.0.1 port 54000.\r\nchannel 2: open failed: administratively prohibited: open failed\n",
    );
    expect(output.listening).toBe(true);
    expect(output.refused).toBe(true);
    expect(output.held).toBe(0);
    for (let i = 0; i < 10000; i++) output.push(`debug1: channel ${i}: new [direct-tcpip]\n`);
    expect(output.held).toBe(0);
    output.push("Connection to 127.0.0.1 closed by remote host.\n");
    expect(output.facts).not.toBe(0);
  });

  it("holds at most a bounded part of an unfinished line, and drops an overlong one to its end", () => {
    const output = new ForwardOutput(54000);
    output.push("x".repeat(MAX_PENDING_LINE - 1));
    expect(output.held).toBe(MAX_PENDING_LINE - 1);
    output.push("x".repeat(10 * 1024 * 1024));
    expect(output.held).toBe(0);
    output.push("still the same line");
    expect(output.held).toBe(0);
    output.push(" and its end\nTimeout, server 127.0.0.1 not responding.\n");
    expect(output.held).toBe(0);
  });

  it("drops a line longer than its limit whether it comes in one chunk or split before its end", () => {
    const line = "Connection refused " + "x".repeat(MAX_PENDING_LINE) + "\n";
    const whole = new ForwardOutput(54000);
    whole.push(line);
    const split = new ForwardOutput(54000);
    split.push(line.slice(0, -1));
    split.push("\n");
    expect(failureFromFacts(whole.facts, 255)).toEqual({ kind: "ssh-stopped", exit: 255 });
    expect(failureFromFacts(split.facts, 255)).toEqual({ kind: "ssh-stopped", exit: 255 });
    // A line within the limit is read either way.
    const short = new ForwardOutput(54000);
    short.push("ssh: connect to host 127.0.0.1 port 1: Connection refused\n");
    expect(failureFromFacts(short.facts, 255)).toMatchObject({ kind: "unreachable" });
  });

  it.each(RECORDED)(
    "classifies as the whole output does: %s, %s",
    (_client, _case, stderr, expected) => {
      const exit = "exit" in expected && expected.exit !== null ? expected.exit : 255;
      const output = new ForwardOutput(54000);
      for (const piece of stderr.match(/[\s\S]{1,7}/g) ?? []) output.push(piece);
      output.push("\n");
      expect(failureFromFacts(output.facts, exit)).toEqual(expected);
    },
  );
});
