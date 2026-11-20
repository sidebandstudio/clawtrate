// Clawtrate development sign-ins: scripted sign-ins for the scripted provider
// `acme`, for development gateway instances only.
//
// Loaded by `pnpm dev-gateway start --instance <name> --with-accounts
// --with-plugin clawtrate-dev-signin`. It gives the gateway five sign-in
// methods for `acme`, which a client starts with `models.authLogin` and
// steps with `wizard.next`, as it would a real provider's:
//
//   clawtrate-dev-signin/acme-device-code   a link and a code; the gateway polls
//   clawtrate-dev-signin/acme-browser       a page to open, then the code (or the
//                                           address the browser landed on) pasted back
//   clawtrate-dev-signin/acme-host          finishes on the gateway's machine: a note
//                                           with the page and the port to forward, and
//                                           the browser sent back to a listener there
//   clawtrate-dev-signin/acme-callback      a model of OpenRouter's: the gateway's own
//                                           callback when the connection has a browser
//                                           origin it accepts, otherwise notes, the
//                                           page, and the address pasted back
//   clawtrate-dev-signin/acme-api-key       a key typed in, checked by the provider
//
// and Globex a key method only, so a key for it goes through the gateway's
// own `models.authSetApiKey`, which replaces the key the gateway has.
//
// The "provider" is the instance's own scripted model (`signinUrl`, set by the
// tool to a path on it). This plugin never contacts anything else: it refuses
// a `signinUrl` whose host is not 127.0.0.1, and the listener the sign-in
// on the gateway's machine opens binds 127.0.0.1 only. Every credential it saves is
// a made-up development string the scripted model minted.
//
// It works only inside a named development instance the dev-gateway tool
// started (`developmentInstanceProblem`): the gateway's state folder is
// `~/.openclaw-clawtrate-dev-<name>` with the tool's marker naming that
// instance and this very gateway process, and the plugin's code lies inside
// that folder (the gateway loads a build of the tool's copy from there). On any other gateway it registers nothing and
// says why in the log; each sign-in method checks again before it runs.

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDER = "acme";
/** What the dev-gateway tool leaves in an instance's state folder (state-guard.ts). */
const MARKER_FILE = ".clawtrate-dev-gateway";
const CREATED_BY = "clawtrate tools/dev-gateway";
const STATE_FOLDER = /^\.openclaw-clawtrate-dev-([a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?)$/;

/**
 * Why this process is not the gateway of a named development instance the
 * dev-gateway tool started, or null. The evidence is the tool's own: the
 * state folder and profile the tool runs OpenClaw with, the marker it writes
 * there before it starts the gateway, which records the gateway's process,
 * and the plugin's own code lying inside that folder.
 */
export function developmentInstanceProblem(
  env = process.env,
  pid = process.pid,
  here = fileURLToPath(import.meta.url),
) {
  const stateDir = env.OPENCLAW_STATE_DIR;
  if (!stateDir) return "the gateway runs with no OPENCLAW_STATE_DIR";
  const match = STATE_FOLDER.exec(basename(stateDir));
  if (!match || dirname(stateDir) !== homedir()) {
    return `the gateway's state folder ${stateDir} is not a named development instance's (~/.openclaw-clawtrate-dev-<name>)`;
  }
  const instance = match[1];
  if (env.OPENCLAW_PROFILE !== `clawtrate-dev-${instance}`) {
    return `the gateway's profile is ${JSON.stringify(env.OPENCLAW_PROFILE ?? null)}, not clawtrate-dev-${instance}`;
  }
  let marker;
  try {
    const folder = lstatSync(stateDir);
    if (folder.isSymbolicLink() || !folder.isDirectory() || realpathSync(stateDir) !== stateDir) {
      return `${stateDir} is not a real folder`;
    }
    const file = lstatSync(join(stateDir, MARKER_FILE));
    if (file.isSymbolicLink() || !file.isFile())
      return `${stateDir} has no marker of the dev-gateway tool`;
    marker = JSON.parse(readFileSync(join(stateDir, MARKER_FILE), "utf8"));
  } catch {
    return `${stateDir} has no readable marker of the dev-gateway tool`;
  }
  if (marker?.createdBy !== CREATED_BY || marker.instance !== instance) {
    return `${stateDir}'s marker is not the dev-gateway tool's for instance ${instance}`;
  }
  if (marker.gatewayPid !== pid) {
    return `this process (${pid}) is not the gateway the tool started on ${instance} (${String(marker.gatewayPid)})`;
  }
  let real;
  try {
    real = realpathSync(here);
  } catch {
    return "the plugin cannot find its own file";
  }
  if (!real.startsWith(stateDir + sep)) {
    return `the plugin runs from ${real}, outside the instance's state folder`;
  }
  return null;
}

/** Refuse to go on outside a development instance the tool started. */
function assertDevelopmentInstance() {
  const problem = developmentInstanceProblem();
  if (problem) throw new Error(`clawtrate-dev-signin refuses to sign in: ${problem}`);
}
const LABEL = "Acme (scripted)";

function signinBase(api) {
  const raw = api.pluginConfig?.signinUrl;
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error("clawtrate-dev-signin: signinUrl is not a URL");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("clawtrate-dev-signin: signinUrl must be the scripted model on 127.0.0.1");
  }
  return url.href.replace(/\/$/, "");
}

/**
 * One request to the scripted sign-in. The address is checked as loopback
 * when the request is made, and a redirect is never followed: it ends the
 * sign-in as a failure, so nothing the plugin sends can reach another address.
 */
async function call(api, path, body, signal) {
  const url = new URL(`${signinBase(api)}${path}`);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error(
      `${LABEL} sign-in failed: ${url.origin} is not the scripted model on 127.0.0.1`,
    );
  }
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
    redirect: "manual",
  });
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    throw new Error(
      `${LABEL} sign-in failed: the scripted sign-in answered with a redirect, which this plugin never follows`,
    );
  }
  const answer = await response.json();
  if (!response.ok) {
    throw new Error(answer?.error?.message ?? `scripted sign-in answered ${response.status}`);
  }
  return answer;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("cancelled"));
      },
      { once: true },
    );
  });
}

/** The outcome the scripted side reported, as the error a refused or expired sign-in ends with. */
function outcomeError(answer) {
  if (answer.status === "expired") return new Error(`${LABEL} sign-in expired: ${answer.error}`);
  return new Error(`${LABEL} refused the sign-in: ${answer.error}`);
}

/**
 * A provider setting the gateway's own config schema refuses: returned with a
 * sign-in the scripted page approved as "unconfirmed", the gateway saves the
 * account, cannot apply the setting, and ends the sign-in in its own words
 * ("Credentials saved, but provider settings could not be applied: …"). The
 * write is refused whole, so nothing of it lands.
 */
const UNAPPLIABLE = { models: { providers: { [PROVIDER]: { api: "clawtrate-dev-refused" } } } };

function oauthResult(tokens, confirmed = true) {
  return {
    ...(confirmed === false ? { configPatch: UNAPPLIABLE } : {}),
    profiles: [
      {
        profileId: tokens.account,
        credential: {
          type: "oauth",
          provider: PROVIDER,
          access: tokens.access,
          refresh: tokens.refresh,
          expires: tokens.expires,
          email: tokens.email,
        },
      },
    ],
    notes: ["A scripted development sign-in; no real provider was contacted."],
  };
}

function deviceCodeMethod(api) {
  return {
    id: "device-code",
    label: LABEL,
    hint: "a link and a code",
    kind: "device_code",
    async run(ctx) {
      assertDevelopmentInstance();
      const started = await call(api, "/device/start", { provider: PROVIDER }, ctx.signal);
      await ctx.openUrl(started.verificationUri);
      const expiresInMinutes = Math.max(1, Math.round(started.expiresInSeconds / 60));
      if (ctx.prompter.deviceCode) {
        await ctx.prompter.deviceCode({
          title: LABEL,
          code: started.userCode,
          expiresInMinutes,
          message: "Enter this code on the scripted sign-in page.",
        });
      } else {
        await ctx.prompter.note(
          `Open ${started.verificationUri} and enter ${started.userCode}.`,
          LABEL,
        );
      }
      for (;;) {
        ctx.signal?.throwIfAborted();
        ctx.assertCurrent?.();
        const answer = await call(
          api,
          "/device/poll",
          { deviceCode: started.deviceCode },
          ctx.signal,
        );
        if (answer.status === "approved") return oauthResult(answer.tokens, answer.confirmed);
        if (answer.status !== "pending") throw outcomeError(answer);
        await sleep(started.intervalSeconds * 1000, ctx.signal);
      }
    },
  };
}

/** The code from what was pasted: the code itself, or the address the browser landed on. */
function pastedCode(pasted) {
  const text = String(pasted ?? "").trim();
  if (!/^https?:\/\//.test(text)) return { code: text };
  const params = new URL(text).searchParams;
  if (params.get("error")) return { error: params.get("error") };
  return { code: params.get("code") ?? "" };
}

function browserMethod(api) {
  return {
    id: "browser",
    label: `${LABEL} in the browser`,
    hint: "paste the code back",
    kind: "oauth",
    async run(ctx) {
      assertDevelopmentInstance();
      const started = await call(api, "/browser/start", { provider: PROVIDER }, ctx.signal);
      await ctx.openUrl(started.authorizeUrl);
      const pasted = await ctx.prompter.text({
        message: "Paste the code, or the whole address your browser landed on.",
        placeholder: "Code or address",
        sensitive: true,
        signal: ctx.signal,
        validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
      });
      const parsed = pastedCode(pasted);
      if (parsed.error) throw outcomeError({ status: "refused", error: parsed.error });
      ctx.assertCurrent?.();
      const answer = await call(
        api,
        "/browser/exchange",
        { provider: PROVIDER, code: parsed.code },
        ctx.signal,
      );
      if (answer.status === "approved") return oauthResult(answer.tokens, answer.confirmed);
      throw outcomeError(answer);
    },
  };
}

/**
 * Wait, on the gateway's own machine, for the browser to come back from the
 * scripted page: a listener on 127.0.0.1 at a port of its own, which takes one
 * callback with the sign-in's state and its code, and closes. It is what a
 * sign-in that finishes on the gateway's machine binds (Sign in with ChatGPT's
 * fixed localhost:8080).
 */
async function loopbackCallback(signal) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  let settle;
  const arrived = new Promise((resolve, reject) => (settle = { resolve, reject }));
  server.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      "<!doctype html><title>Scripted sign-in</title><p>Back on the gateway. You can close this page.</p>",
    );
    settle.resolve(url.searchParams);
  });
  const close = () => new Promise((resolve) => server.close(() => resolve()));
  const abort = () => settle.reject(signal.reason ?? new Error("cancelled"));
  signal?.addEventListener("abort", abort, { once: true });
  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    port,
    async wait() {
      try {
        return await arrived;
      } finally {
        signal?.removeEventListener("abort", abort);
        await close();
      }
    },
    close,
  };
}

/** A browser sign-in that ends with the browser sent back to the gateway's machine. */
function returningMethod(api, { id, label, hint, note }) {
  return {
    id,
    label,
    hint,
    kind: "oauth",
    async run(ctx) {
      assertDevelopmentInstance();
      const callback = await loopbackCallback(ctx.signal);
      try {
        const started = await call(
          api,
          "/browser/start",
          { provider: PROVIDER, redirectUri: callback.redirectUri },
          ctx.signal,
        );
        await ctx.openUrl(started.authorizeUrl);
        // The gateway's own form for a sign-in on its machine: a note with the page.
        await ctx.prompter.note(note(callback.port), label);
        const back = await callback.wait();
        if (back.get("state") !== started.state)
          throw outcomeError({
            status: "refused",
            error: "the browser came back with another sign-in's state",
          });
        if (back.get("error")) throw outcomeError({ status: "refused", error: back.get("error") });
        ctx.assertCurrent?.();
        const answer = await call(
          api,
          "/browser/exchange",
          { provider: PROVIDER, code: back.get("code") ?? "" },
          ctx.signal,
        );
        if (answer.status === "approved") return oauthResult(answer.tokens, answer.confirmed);
        throw outcomeError(answer);
      } finally {
        await callback.close();
      }
    },
  };
}

function hostMethod(api) {
  return returningMethod(api, {
    id: "host",
    label: `${LABEL} on the gateway's machine`,
    hint: "finishes on the gateway's machine",
    // In the words OpenClaw's own sign-in on the gateway's machine uses.
    note: (port) =>
      [
        "Sign in on the scripted page. Nothing here is a real provider.",
        `Open the sign-in link in your browser. Its 127.0.0.1:${port} callback must reach this OpenClaw process. For an SSH host, forward the port with: ssh -N -L ${port}:127.0.0.1:${port} user@gateway-host`,
      ].join("\n\n"),
  });
}

/** The redirect address pasted back, read as OpenRouter reads it: its state must be this one's. */
function pastedRedirect(pasted, expectedState) {
  let url;
  try {
    url = new URL(String(pasted ?? "").trim());
  } catch {
    throw new Error("Paste the whole address your browser landed on.");
  }
  if (url.searchParams.get("state") !== expectedState)
    throw new Error("That address belongs to another sign-in.");
  const error = url.searchParams.get("error");
  if (error) return { error };
  const code = url.searchParams.get("code");
  if (!code) throw new Error("That address carries no code.");
  return { code };
}

/**
 * A local model of OpenRouter's browser sign-in as the installed gateway runs
 * it (OpenClaw 2026.10.6, `resolveOpenRouterOAuthCode` in `oauth-*.mjs`, and
 * `provider-browser-auth-*.mjs`), so a client is checked against the order of
 * steps and the callback's conditions a real provider has:
 *
 * - The gateway's own callback (`ctx.oauth.authorize`) exists only when the
 *   connection has a browser origin the gateway accepts: `https` on the
 *   gateway's host, loopback `http` from a local client, or its published
 *   Tailscale origin. The redirect is then the gateway's
 *   `/oauth/provider/callback` on that origin, which the gateway chooses, and
 *   the gateway refuses an authorization page that is not `https` or carries
 *   a user name or password. The scripted page is `http`, so here the gateway
 *   refuses it, as it would a real provider's `http` page.
 * - Otherwise, as for a client with no browser origin (Clawtrate's host): a
 *   note with no page, the page opened, a note carrying it, then a text step,
 *   not marked secret, for the redirect address pasted back, whose state must
 *   match. Nothing listens at that address: the browser lands on a page that
 *   does not open, and the person copies it.
 */
function callbackMethod(api) {
  return {
    id: "callback",
    label: `${LABEL}, back to the gateway`,
    hint: "the gateway's callback, or the address pasted back",
    kind: "oauth",
    async run(ctx) {
      assertDevelopmentInstance();
      const started = await call(api, "/browser/start", { provider: PROVIDER }, ctx.signal);
      const exchange = async (parsed) => {
        if (parsed.error) throw outcomeError({ status: "refused", error: parsed.error });
        ctx.assertCurrent?.();
        const answer = await call(
          api,
          "/browser/exchange",
          { provider: PROVIDER, code: parsed.code },
          ctx.signal,
        );
        if (answer.status === "approved") return oauthResult(answer.tokens, answer.confirmed);
        throw outcomeError(answer);
      };
      if (ctx.oauth?.authorize) {
        const back = await ctx.oauth.authorize({
          state: started.state,
          timeoutMs: 5 * 60_000,
          buildAuthorizationUrl: (redirectUrl) => {
            const url = new URL(started.authorizeUrl);
            url.searchParams.set("redirect_uri", redirectUrl);
            return url.href;
          },
        });
        return await exchange({ code: back.code });
      }
      await ctx.prompter.note(
        [
          "Open this URL in your LOCAL browser.",
          "After signing in, paste the redirect URL back here.",
        ].join("\n"),
        LABEL,
      );
      await ctx.openUrl(started.authorizeUrl);
      await ctx.prompter.note(
        `Open this URL in your LOCAL browser:\n\n${started.authorizeUrl}`,
        LABEL,
      );
      const pasted = await ctx.prompter.text({
        message: `Paste the ${LABEL} redirect URL`,
        placeholder: "http://127.0.0.1/scripted/signin/browser/landed?code=...&state=...",
        signal: ctx.signal,
        validate: (value) => {
          try {
            pastedRedirect(value, started.state);
            return undefined;
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        },
      });
      return await exchange(pastedRedirect(pasted, started.state));
    },
  };
}

function apiKeyMethod(api) {
  return {
    id: "api-key",
    label: `${LABEL} API key`,
    hint: "billed per token",
    kind: "api_key",
    async run(ctx) {
      assertDevelopmentInstance();
      const key = String(
        await ctx.prompter.text({
          message: "Acme API key",
          placeholder: "clawtrate-dev-key.acme.<name>",
          sensitive: true,
          signal: ctx.signal,
          validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
        }),
      ).trim();
      ctx.assertCurrent?.();
      const answer = await call(api, "/key/check", { provider: PROVIDER, key }, ctx.signal);
      if (answer.status !== "approved") throw outcomeError(answer);
      return {
        profiles: [
          { profileId: answer.account, credential: { type: "api_key", provider: PROVIDER, key } },
        ],
      };
    },
  };
}

export default {
  id: "clawtrate-dev-signin",
  name: "Clawtrate development sign-ins",
  description: "Scripted sign-ins for the scripted provider acme, on loopback only.",
  register(api) {
    const problem = developmentInstanceProblem();
    if (problem) {
      const say = api.logger?.warn?.bind(api.logger) ?? console.warn;
      say(`clawtrate-dev-signin registers no sign-ins here: ${problem}`);
      return;
    }
    // Checked once at load, so a wrong address fails the start, not a sign-in.
    signinBase(api);
    api.registerProvider({
      id: PROVIDER,
      label: LABEL,
      auth: [
        deviceCodeMethod(api),
        browserMethod(api),
        hostMethod(api),
        callbackMethod(api),
        apiKeyMethod(api),
      ],
      async refreshOAuth(credential) {
        assertDevelopmentInstance();
        const answer = await call(api, "/refresh", { refresh: credential.refresh });
        return {
          ...credential,
          access: answer.tokens.access,
          refresh: answer.tokens.refresh,
          expires: answer.tokens.expires,
        };
      },
    });
    // Globex takes a key through the gateway's own key method (`models.authSetApiKey`), which
    // replaces the key the gateway has for it; it has no sign-in of its own.
    api.registerProvider({
      id: "globex",
      label: "Globex (scripted)",
      auth: [
        {
          id: "api-key",
          label: "Globex API key (scripted)",
          kind: "api_key",
          async run() {
            assertDevelopmentInstance();
            throw new Error(
              "Globex has no sign-in here: save its key with the gateway's key method.",
            );
          },
        },
      ],
    });
  },
};
