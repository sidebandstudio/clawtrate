// The destination, the person's SSH configuration and the configuration the
// host writes: every honored setting, every refusal, and hostile input.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseDestination } from "../../src/main/ssh/destination.ts";
import { hostLineMatches, resolveTarget, type Target } from "../../src/main/ssh/person-config.ts";
import { pathValue, routeConfigText } from "../../src/main/ssh/route-config.ts";
import type { SshWorld } from "../../src/main/ssh/world.ts";
import { SSH, tempDir, testEnv } from "./harness.ts";

let root: string;
let world: SshWorld;

beforeAll(() => {
  root = tempDir("clawtrate-ssh-config-");
  mkdirSync(join(root, "home", ".ssh"), { recursive: true });
  world = {
    home: join(root, "home"),
    personConfig: join(root, "home", ".ssh", "config"),
    personKnownHosts: join(root, "home", ".ssh", "known_hosts"),
    ssh: SSH,
    appDir: join(root, "app"),
    localUser: "you",
    agent: "none",
    platform: process.platform === "win32" ? "linux" : process.platform,
    env: testEnv(),
  };
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const resolveWith = (text: string, typed = "devbox") => {
  writeFileSync(world.personConfig, text);
  return resolveTarget(world, parseDestination(typed)!);
};

describe("the destination", () => {
  it("accepts an alias, a host name and user@host, and shows them back whole", () => {
    expect(parseDestination("devbox")).toEqual({ typed: "devbox", user: null, host: "devbox" });
    expect(parseDestination("you@devbox.example")).toEqual({
      typed: "you@devbox.example",
      user: "you",
      host: "devbox.example",
    });
    expect(parseDestination("_ci.bot-1@198.51.100.7")?.host).toBe("198.51.100.7");
  });

  it.each([
    ["an option smuggled as the host", "-oProxyCommand=touch"],
    ["an option after the user", "you@-oProxyCommand=x"],
    ["a user starting with a dash", "-you@devbox"],
    ["a host starting with a dot", ".devbox"],
    ["a space", "dev box"],
    ["a newline", "devbox\nProxyCommand x"],
    ["a carriage return", "devbox\r"],
    ["a tab", "dev\tbox"],
    ["a percent token", "%h"],
    ["a percent token in the host", "dev%dbox"],
    ["a variable", "${HOME}"],
    ["a port after a colon", "devbox:22"],
    ["an IPv6 address", "2001:db8::1"],
    ["a path", "devbox/x"],
    ["quotes", '"devbox"'],
    ["a single quote", "dev'box"],
    ["a semicolon", "devbox;true"],
    ["a backtick", "devbox`id`"],
    ["two at signs", "a@b@c"],
    ["an empty user", "@devbox"],
    ["empty", ""],
    ["a non-ASCII letter", "dévbox"],
    ["too long a host", "a".repeat(254)],
    ["too long a user", `${"u".repeat(65)}@devbox`],
  ])("refuses %s", (_name, typed) => {
    expect(parseDestination(typed)).toBeNull();
  });

  it("refuses what isn't a string", () => {
    for (const value of [undefined, null, 1, ["devbox"], { host: "devbox" }]) {
      expect(parseDestination(value)).toBeNull();
    }
  });
});

describe("the person's SSH configuration", () => {
  it("takes the six settings from the matching block", () => {
    const target = resolveWith(
      [
        "# my hosts",
        "Host devbox",
        "  HostName devbox.example",
        "  User you",
        "  Port 2222",
        "  IdentityFile ~/.ssh/id_ed25519",
        '  IdentityFile "~/.ssh/second key"',
        "  IdentitiesOnly yes",
        "  CertificateFile ~/.ssh/id_ed25519-cert.pub",
        "",
      ].join("\n"),
    );
    expect(target).toMatchObject({
      ok: true,
      name: "devbox",
      hostName: "devbox.example",
      user: "you",
      port: 2222,
      identitiesOnly: true,
      identityFiles: [
        join(world.home, ".ssh", "id_ed25519"),
        join(world.home, ".ssh", "second key"),
      ],
      certificateFiles: [join(world.home, ".ssh", "id_ed25519-cert.pub")],
    });
  });

  it("is a plain host with port 22 and the local user when nothing matches, or there is no file", () => {
    expect(resolveWith("Host other\n  HostName 192.0.2.1\n", "devbox.example")).toMatchObject({
      ok: true,
      hostName: "devbox.example",
      user: "you",
      port: 22,
      identityFiles: [],
      identitiesOnly: null,
    });
    rmSync(world.personConfig);
    expect(resolveTarget(world, parseDestination("devbox")!)).toMatchObject({
      ok: true,
      hostName: "devbox",
    });
  });

  it("follows OpenSSH: the first value wins across matching blocks, keys add up, the typed user wins", () => {
    const target = resolveWith(
      [
        "User fromtop",
        "Host dev*",
        "  Port 2200",
        "  IdentityFile ~/.ssh/a",
        "Host devbox",
        "  Port 2222",
        "  User you",
        "  IdentityFile ~/.ssh/b",
        "Host *",
        "  IdentitiesOnly no",
        "",
      ].join("\n"),
      "me@devbox",
    );
    expect(target).toMatchObject({
      user: "me",
      port: 2200,
      identitiesOnly: false,
      identityFiles: [join(world.home, ".ssh", "a"), join(world.home, ".ssh", "b")],
    });
    expect(resolveWith("User fromtop\nHost devbox\n  User you\n")).toMatchObject({
      user: "fromtop",
    });
  });

  it("matches host patterns as OpenSSH does: wildcards, negation, case", () => {
    expect(hostLineMatches(["dev*"], "devbox")).toBe(true);
    expect(hostLineMatches(["d?vbox"], "devbox")).toBe(true);
    expect(hostLineMatches(["DEVBOX"], "devbox")).toBe(true);
    expect(hostLineMatches(["*", "!devbox"], "devbox")).toBe(false);
    expect(hostLineMatches(["!devbox"], "other")).toBe(false);
    expect(hostLineMatches(["dev.box"], "devxbox")).toBe(false);
    expect(hostLineMatches(["other", "devbox"], "devbox")).toBe(true);
  });

  it("accepts the Key=Value form and quoted values", () => {
    expect(
      resolveWith('Host devbox\n  HostName=devbox.example\n  IdentityFile "~/.ssh/my key"\n'),
    ).toMatchObject({
      hostName: "devbox.example",
      identityFiles: [join(world.home, ".ssh", "my key")],
    });
  });

  it("follows an Include outside any block, with a pattern in its last part", () => {
    mkdirSync(join(world.home, ".ssh", "config.d"), { recursive: true });
    writeFileSync(join(world.home, ".ssh", "config.d", "10-dev"), "Host devbox\n  Port 2201\n");
    writeFileSync(join(world.home, ".ssh", "config.d", "20-other"), "Host other\n  Port 9\n");
    expect(resolveWith("Include config.d/*\nHost devbox\n  Port 2222\n")).toMatchObject({
      port: 2201,
    });
    expect(resolveWith("Include ~/.ssh/config.d/10-dev\n")).toMatchObject({ port: 2201 });
    // A missing included file is skipped, as OpenSSH does.
    expect(resolveWith("Include config.d/none\n")).toMatchObject({ ok: true, port: 22 });
  });

  it("does not follow an Include out of the home folder", () => {
    expect(resolveWith("Include /etc/ssh/ssh_config\n")).toMatchObject({
      ok: false,
      category: "unreadable",
    });
  });

  it.each([
    [
      "ProxyJump",
      "ProxyJump bastion.example",
      "jump-host",
      "devbox is reached through another computer.",
    ],
    [
      "ProxyCommand",
      "ProxyCommand nc %h %p",
      "jump-host",
      "devbox is reached through another computer.",
    ],
    ["LocalCommand", "LocalCommand touch x", "command-or-forward", null],
    ["PermitLocalCommand", "PermitLocalCommand yes", "command-or-forward", null],
    ["RemoteCommand", "RemoteCommand tmux attach", "command-or-forward", null],
    ["LocalForward", "LocalForward 8080 127.0.0.1:80", "command-or-forward", null],
    ["RemoteForward", "RemoteForward 9000 127.0.0.1:9000", "command-or-forward", null],
    ["DynamicForward", "DynamicForward 1080", "command-or-forward", null],
    ["SendEnv", "SendEnv LANG", "command-or-forward", null],
    ["SetEnv", "SetEnv FOO=bar", "command-or-forward", null],
    ["ForwardAgent", "ForwardAgent yes", "command-or-forward", null],
    ["ForwardX11", "ForwardX11 yes", "command-or-forward", null],
    ["ControlMaster", "ControlMaster auto", "command-or-forward", null],
    ["ControlPath", "ControlPath ~/.ssh/cm-%C", "command-or-forward", null],
    ["Include", "Include other", "command-or-forward", null],
    [
      "StrictHostKeyChecking",
      "StrictHostKeyChecking no",
      "host-key",
      "devbox's SSH settings change how its key is checked.",
    ],
    ["UserKnownHostsFile", "UserKnownHostsFile /dev/null", "host-key", null],
    ["GlobalKnownHostsFile", "GlobalKnownHostsFile none", "host-key", null],
    ["KnownHostsCommand", "KnownHostsCommand /bin/true", "host-key", null],
    ["UpdateHostKeys", "UpdateHostKeys yes", "host-key", null],
    ["HostKeyAlias", "HostKeyAlias other", "host-key", null],
    ["VerifyHostKeyDNS", "VerifyHostKeyDNS yes", "host-key", null],
    ["RevokedHostKeys", "RevokedHostKeys ~/.ssh/revoked", "host-key", null],
  ])("refuses %s in a matching block, by name", (setting, line, category, title) => {
    const refusal = resolveWith(`Host devbox\n  HostName devbox.example\n  ${line}\n`);
    expect(refusal).toMatchObject({ ok: false, kind: "refused", category, setting });
    if (title) expect(refusal).toMatchObject({ title });
    // The same setting in a block that doesn't match is not the route's concern.
    if (setting !== "Include") {
      expect(resolveWith(`Host other\n  ${line}\nHost devbox\n  Port 2222\n`)).toMatchObject({
        ok: true,
      });
    }
  });

  it("refuses a refused setting that applies to every host", () => {
    expect(resolveWith("Host *\n  ForwardAgent yes\n")).toMatchObject({
      ok: false,
      setting: "ForwardAgent",
    });
    expect(resolveWith("ProxyJump bastion.example\n")).toMatchObject({
      ok: false,
      setting: "ProxyJump",
    });
  });

  it("refuses any Match, whose conditions can't be evaluated without running them", () => {
    expect(resolveWith('Host devbox\n  Port 2222\nMatch exec "true"\n  User root\n')).toMatchObject(
      {
        ok: false,
        category: "command-or-forward",
        setting: "Match",
        title: "devbox's SSH settings run a command or open other forwards.",
        sentence:
          "Clawtrate only opens one forward, with no commands of yours. Add a plain alias for devbox to your SSH configuration and use that.",
      },
    );
  });

  it("refuses a setting it does not know, by name", () => {
    expect(resolveWith("Host devbox\n  CanonicalizeHostname yes\n")).toMatchObject({
      ok: false,
      category: "unsupported",
      setting: "CanonicalizeHostname",
    });
  });

  it("leaves out settings that run nothing and don't touch the key check", () => {
    expect(
      resolveWith(
        "Host devbox\n  AddKeysToAgent yes\n  ServerAliveInterval 5\n  Compression yes\n  Port 2222\n",
      ),
    ).toMatchObject({ ok: true, port: 2222 });
  });

  it.each([
    ["a percent token in HostName", "HostName %h.example", "HostName"],
    ["a variable in IdentityFile", "IdentityFile ${HOME}/.ssh/id", "IdentityFile"],
    ["a token in IdentityFile", "IdentityFile ~/.ssh/id_%r", "IdentityFile"],
    ["a key outside the home folder", "IdentityFile /etc/ssh/ssh_host_ed25519_key", "IdentityFile"],
    ["a key climbing out of the home folder", "IdentityFile ~/../other/.ssh/id", "IdentityFile"],
    ["a relative key", "IdentityFile id_ed25519", "IdentityFile"],
    ["another user's home", "IdentityFile ~root/.ssh/id", "IdentityFile"],
    ["a port out of range", "Port 70000", "Port"],
    ["a port with letters", "Port 22x", "Port"],
    ["a user with a dash first", "User -oProxyCommand=x", "User"],
    ["a host name with a dash first", "HostName -oProxyCommand=x", "HostName"],
    ["a host name with spaces", "HostName devbox -p 1", "HostName"],
    ["an IdentitiesOnly that isn't yes or no", "IdentitiesOnly maybe", "IdentitiesOnly"],
    ["an unbalanced quote", 'IdentityFile "~/.ssh/id', "IdentityFile"],
    ["a quote inside a value", 'IdentityFile ~/.ssh/i"d', "IdentityFile"],
    ["a backslash", "IdentityFile ~/.ssh/a\\b", "IdentityFile"],
  ])("refuses %s", (_name, line, setting) => {
    expect(resolveWith(`Host devbox\n  ${line}\n`)).toMatchObject({
      ok: false,
      category: "invalid-value",
      setting,
    });
  });

  it("refuses a file it can't read as SSH configuration", () => {
    expect(resolveWith("Host devbox\n  !!!\n")).toMatchObject({
      ok: false,
      category: "unreadable",
    });
    expect(resolveWith("Host 'devbox'\n")).toMatchObject({ ok: false, category: "unreadable" });
    writeFileSync(world.personConfig, "#".repeat(300 * 1024));
    expect(resolveTarget(world, parseDestination("devbox")!)).toMatchObject({
      ok: false,
      category: "unreadable",
    });
  });

  it("refuses an Include loop instead of following it for ever", () => {
    writeFileSync(join(world.home, ".ssh", "loop"), "Include loop\n");
    expect(resolveWith("Include loop\n")).toMatchObject({ ok: false, category: "unreadable" });
  });
});

const target = (overrides: Partial<Target> = {}): Target => ({
  ok: true,
  destination: parseDestination("devbox")!,
  name: "devbox",
  hostName: "devbox.example",
  user: "you",
  port: 22,
  identityFiles: [],
  identitiesOnly: null,
  certificateFiles: [],
  ...overrides,
});

describe("the configuration the host writes", () => {
  it("is one directive per line, with its fixed options and no forwards", () => {
    const text = routeConfigText(
      "1",
      target({
        identityFiles: ["/srv/you/.ssh/id_ed25519"],
        identitiesOnly: true,
        certificateFiles: ["/srv/you/.ssh/id_ed25519-cert.pub"],
      }),
      { ...world, agent: "inherit" },
      "/srv/app/known_hosts",
    );
    expect(text).toBe(
      [
        "Host clawtrate-route-1",
        "  HostName devbox.example",
        "  User you",
        "  Port 22",
        "  IdentityFile /srv/you/.ssh/id_ed25519",
        "  IdentitiesOnly yes",
        "  CertificateFile /srv/you/.ssh/id_ed25519-cert.pub",
        "  HostKeyAlias clawtrate-route-1",
        "  UserKnownHostsFile /srv/app/known_hosts",
        "  GlobalKnownHostsFile none",
        "  StrictHostKeyChecking yes",
        "  UpdateHostKeys no",
        "  BatchMode yes",
        "  ConnectTimeout 10",
        "  ServerAliveInterval 15",
        "  ServerAliveCountMax 3",
        "  ExitOnForwardFailure yes",
        "  ClearAllForwardings yes",
        "  ForwardAgent no",
        "  ForwardX11 no",
        "  PermitLocalCommand no",
        "  ControlMaster no",
        "  ControlPath none",
        "  RequestTTY no",
        "",
      ].join("\n"),
    );
    expect(text).not.toMatch(
      /Forward [0-9]|LocalForward|RemoteForward|DynamicForward|ProxyCommand|ProxyJump/,
    );
  });

  it("adds IdentityAgent none when the world has no agent", () => {
    expect(routeConfigText("1", target(), world, "/srv/app/known_hosts")).toContain(
      "\n  IdentityAgent none\n",
    );
  });

  it("looks up prior trust with the person's known-hosts file and without the route's alias", () => {
    const text = routeConfigText("1", target(), world, "/srv/app/known_hosts", "lookup");
    expect(text).not.toContain("HostKeyAlias");
    expect(text).toContain(`  UserKnownHostsFile ${world.personKnownHosts}\n`);
    expect(text).toContain("  StrictHostKeyChecking yes\n");
  });

  it("quotes a path with a space, writes Windows paths with forward slashes, and refuses anything ssh would expand", () => {
    expect(pathValue("/srv/Application Support/known_hosts", "darwin")).toBe(
      '"/srv/Application Support/known_hosts"',
    );
    expect(pathValue("C:\\ProgramData\\Clawtrate\\known_hosts", "win32")).toBe(
      "C:/ProgramData/Clawtrate/known_hosts",
    );
    for (const bad of [
      "/srv/%d/known_hosts",
      "/srv/${HOME}/kh",
      "~/kh",
      '/srv/a"b',
      "/srv/a'b",
      "/srv/a#b",
      "/srv/a=b",
      "/srv/a\nHost x",
      "/srv/a\\b",
      "relative/kh",
      "/srv/two  spaces",
      "/srv/trailing ",
    ]) {
      expect(() => pathValue(bad, "linux"), bad).toThrow();
    }
  });

  it("refuses a route id, host, user or port that isn't valid", () => {
    expect(() => routeConfigText("A-1", target(), world, "/srv/kh")).toThrow();
    expect(() =>
      routeConfigText("1", target({ hostName: "-oProxyCommand=x" }), world, "/srv/kh"),
    ).toThrow();
    expect(() => routeConfigText("1", target({ user: "a b" }), world, "/srv/kh")).toThrow();
    expect(() => routeConfigText("1", target({ port: 0 }), world, "/srv/kh")).toThrow();
  });

  it.skipIf(!existsSync(SSH))(
    "names its keys explicitly, so ssh adds none of the account's own and uses no agent",
    () => {
      const dir = join(root, "explicit");
      mkdirSync(dir, { recursive: true });
      const home = userInfo().homedir;
      for (const [name, identityFiles] of [
        ["none", []],
        ["one", [join(dir, "id_ed25519")]],
      ] as const) {
        const file = join(dir, `${name}.conf`);
        writeFileSync(
          file,
          routeConfigText(
            "1",
            target({ identityFiles: [...identityFiles] }),
            world,
            join(dir, "kh"),
          ),
        );
        // `-G` on the host's own file only: no Match in it, nothing evaluated, no connection.
        const run = spawnSync(SSH, ["-G", "-F", file, "--", "clawtrate-route-1"], {
          env: testEnv(),
          encoding: "utf8",
        });
        expect(run.status).toBe(0);
        const lines = run.stdout.split("\n");
        expect(lines.filter((line) => line.startsWith("identityfile "))).toEqual(
          identityFiles.length
            ? identityFiles.map((path) => `identityfile ${path}`)
            : ["identityfile none"],
        );
        expect(lines).toContain("identityagent none");
        // No path of any home's .ssh, spelled with `~` or in full, beyond the keys named.
        const homeSsh = lines.filter(
          (line) =>
            line.includes("~/.ssh") || line.includes(join(home, ".ssh")) || line.includes("/.ssh/"),
        );
        expect(homeSsh, name).toEqual([]);
      }
    },
  );

  it("names OpenSSH's default keys of the world's home when the configuration names none", () => {
    writeFileSync(join(world.home, ".ssh", "id_ed25519"), "");
    writeFileSync(join(world.home, ".ssh", "id_rsa"), "");
    try {
      expect(resolveWith("Host devbox\n  HostName devbox.example\n")).toMatchObject({
        identityFiles: [`${world.home}/.ssh/id_rsa`, `${world.home}/.ssh/id_ed25519`],
      });
      // Named ones replace the defaults.
      expect(resolveWith("Host devbox\n  IdentityFile ~/.ssh/work\n")).toMatchObject({
        identityFiles: [`${world.home}/.ssh/work`],
      });
    } finally {
      rmSync(join(world.home, ".ssh", "id_ed25519"));
      rmSync(join(world.home, ".ssh", "id_rsa"));
    }
    expect(resolveWith("Host devbox\n  HostName devbox.example\n")).toMatchObject({
      identityFiles: [],
    });
  });

  it.skipIf(!existsSync(SSH))(
    "reads back in ssh as written: each value whole, spaces included",
    () => {
      const dir = join(root, "with space");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "route.conf");
      writeFileSync(
        file,
        routeConfigText(
          "7",
          target({ identityFiles: [join(dir, "my key")], hostName: "198.51.100.7", port: 2222 }),
          world,
          join(dir, "known_hosts"),
        ),
      );
      // `-G` on the host's own file only: it holds no Match, so nothing is evaluated or run.
      const run = spawnSync(SSH, ["-G", "-F", file, "--", "clawtrate-route-7"], {
        env: testEnv(),
        encoding: "utf8",
      });
      expect(run.status).toBe(0);
      const settings = new Map(
        run.stdout
          .split("\n")
          .map((line) => [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1)]),
      );
      expect(settings.get("hostname")).toBe("198.51.100.7");
      expect(settings.get("port")).toBe("2222");
      expect(settings.get("identityfile")).toBe(join(dir, "my key"));
      expect(settings.get("userknownhostsfile")).toBe(join(dir, "known_hosts"));
      expect(settings.get("hostkeyalias")).toBe("clawtrate-route-7");
      expect(settings.get("stricthostkeychecking")).toBe("true");
      expect(settings.get("clearallforwardings")).toBe("yes");
      expect(settings.get("identityagent")).toBe("none");
      expect(settings.get("controlmaster")).toBe("false");
      expect(settings.get("batchmode")).toBe("yes");
    },
  );
});
