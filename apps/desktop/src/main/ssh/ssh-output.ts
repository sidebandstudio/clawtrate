// What `ssh` wrote to its error output, read in memory and reduced to a
// category (docs/research/setup-flow.md, section 7). No line of it is kept or
// shown: only the category, the one cause in brackets, and the exit status.

export type UnreachableCause =
  "connection refused" | "no such name" | "timed out" | "network unreachable";

export type SshFailure =
  | { kind: "unreachable"; cause: UnreachableCause; exit: number }
  | { kind: "sign-in-refused"; exit: number }
  | { kind: "host-key-unknown"; exit: number }
  | { kind: "host-key-changed"; exit: number }
  | { kind: "dropped"; exit: number }
  | { kind: "local-port-taken"; exit: number }
  | { kind: "timed-out" }
  /** `ssh` could not be started: the program or the system refused it. */
  | { kind: "spawn-failed" }
  | { kind: "ssh-stopped"; exit: number | null };

/** The category of an `ssh` that exited with `exit` after writing `stderr`. */
export function classifySshFailure(stderr: string, exit: number | null): SshFailure {
  // `-v`'s debug lines and a running forward's per-connection channel lines say
  // nothing about why `ssh` itself stopped.
  const text = stderr
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => !/^debug[0-9]: |^channel [0-9]+: /.test(line))
    .join("\n");
  if (exit !== 255) return { kind: "ssh-stopped", exit };
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/.test(text))
    return { kind: "host-key-changed", exit };
  if (/Host key verification failed\./.test(text)) return { kind: "host-key-unknown", exit };
  if (/Permission denied \(/.test(text)) return { kind: "sign-in-refused", exit };
  if (/Address already in use|Could not request local forwarding/.test(text)) {
    return { kind: "local-port-taken", exit };
  }
  if (/Could not resolve hostname/.test(text)) {
    return { kind: "unreachable", cause: "no such name", exit };
  }
  if (/Connection refused/.test(text) && !/closed by remote host/.test(text)) {
    return { kind: "unreachable", cause: "connection refused", exit };
  }
  if (/Network is unreachable|No route to host/.test(text)) {
    return { kind: "unreachable", cause: "network unreachable", exit };
  }
  if (
    /closed by remote host|Timeout, server .* not responding|Connection reset|Broken pipe/.test(
      text,
    )
  ) {
    return { kind: "dropped", exit };
  }
  if (/(Operation|Connection) timed out|timed out during banner exchange/.test(text)) {
    return { kind: "unreachable", cause: "timed out", exit };
  }
  return { kind: "ssh-stopped", exit };
}

/** The `-v` lines a host-key probe reads, and nothing else. */
export type ProbeLines = {
  /** `debug1: Server host key: <type> SHA256:<fingerprint>` */
  serverKey: { type: string; fingerprint: string } | null;
  /** `debug1: Host '…' is known and matches the … host key.` */
  matches: boolean;
  /** `debug1: Found key in <file>:<line>` */
  foundIn: { file: string; line: number } | null;
};

export function readProbeLines(stderr: string): ProbeLines {
  const result: ProbeLines = { serverKey: null, matches: false, foundIn: null };
  for (const raw of stderr.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const server = /^debug1: Server host key: ([a-z0-9@.-]{1,64}) (SHA256:[A-Za-z0-9+/]{43})$/.exec(
      line,
    );
    if (server && !result.serverKey) {
      result.serverKey = { type: server[1]!, fingerprint: server[2]! };
      continue;
    }
    if (
      /^debug1: Host '[^']{1,300}' is known and matches the [A-Z0-9-]{1,32} host key\.$/.test(line)
    ) {
      result.matches = true;
      continue;
    }
    const found = /^debug1: Found key in (.{1,4096}):([0-9]{1,9})$/.exec(line);
    if (found && !result.foundIn) result.foundIn = { file: found[1]!, line: Number(found[2]) };
  }
  return result;
}

/** `debug1: Local forwarding listening on 127.0.0.1 port <n>.` */
export function forwardListening(line: string, port: number): boolean {
  return (
    line.replace(/\r$/, "") === `debug1: Local forwarding listening on 127.0.0.1 port ${port}.`
  );
}

/** The version `ssh -V` reports, for the clients the research ran. */
export type SshVersion = { windows: boolean; major: number; minor: number };

export function parseSshVersion(text: string): SshVersion | null {
  const match = /^OpenSSH_(for_Windows_)?([0-9]{1,2})\.([0-9]{1,2})/m.exec(text);
  if (!match) return null;
  return { windows: Boolean(match[1]), major: Number(match[2]), minor: Number(match[3]) };
}
