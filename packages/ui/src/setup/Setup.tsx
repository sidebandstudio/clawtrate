// Setting up (docs/design/setup.md §3, §4, §6, §7): the first question,
// the look on this computer and what it found, and Connect. What the look
// found comes from the host (`state.setup`); every sentence here is fixed
// copy, and the only values in it are the facts the host checked.

import type {
  ConnectionState,
  HostInfo,
  InstallAction,
  InstallFailure,
  OnboardClassification,
  LookService,
  SetupFailureKind,
  SetupLook,
  SetupRefusal,
  SetupState,
} from "@clawtrate/core";
import {
  INSTALL_NODE_VERSION,
  INSTALL_OPENCLAW_VERSION,
  OLDEST_OPENCLAW_VERSION,
  PROOF_REFUSAL_LINES,
  TESTED_OPENCLAW_VERSION,
  type ProofRefusalKind,
} from "@clawtrate/core";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import logoUrl from "../assets/logo-mark.png";
import { useCommand } from "../bridge.tsx";
import { CommandLine, PRODUCT_NAME, SLOGAN } from "../ConnectScreen.tsx";
import { FullControlConsent } from "../FullControl.tsx";
import { InfoCard, InfoTip } from "../InfoTip.tsx";
import { leaveLook } from "../this-computer.ts";
import {
  BackIcon,
  CheckIcon,
  ChevronIcon,
  ClockIcon,
  CloseIcon,
  PauseIcon,
  PlusIcon,
  WarnIcon,
} from "../icons.tsx";
// The `b-` rows and notes come with bots.css, which Shell and Settings load; importing it
// here too would move it ahead in the cascade and change other screens.
import "./setup.css";

/** The screens the person moves between here; the look's own come from the host. */
export type SetupView = "first" | "here" | "another" | "advanced";

const INSTALL_DOCS = "https://docs.openclaw.ai/install";

/** A screen's title: its heading, focused when the screen appears, and announced. */
function Title({ children, id }: { children: ReactNode; id: string }) {
  return (
    <h2 className="s-title" id={id} tabIndex={-1} data-s-title>
      {children}
    </h2>
  );
}

function Back({ onBack }: { onBack: () => void }) {
  return (
    <div className="s-top">
      <button type="button" className="button" data-variant="quiet" data-size="sm" onClick={onBack}>
        <BackIcon />
        Back
      </button>
    </div>
  );
}

const Mark = () => <img className="s-mark" src={logoUrl} alt="" width={44} height={44} />;

type StepState = "waiting" | "running" | "done" | "failed";

/** The step list (§2 "New components"), with the elapsed time on a step running past 10 s. */
function Steps({
  steps,
  current,
  failed,
  details,
}: {
  steps: string[];
  current: number;
  failed?: boolean;
  /** A line under a step, such as what the installer reported. */
  details?: Array<string | null>;
}) {
  // Seconds on the running step, counted from when it started.
  const [timed, setTimed] = useState({ step: current, seconds: 0 });
  if (timed.step !== current) setTimed({ step: current, seconds: 0 });
  useEffect(() => {
    if (failed) return;
    const timer = setInterval(
      () => setTimed((value) => ({ ...value, seconds: value.seconds + 1 })),
      1000,
    );
    return () => clearInterval(timer);
  }, [failed]);
  const elapsed = timed.seconds;
  return (
    <ol className="s-steps" aria-label="Steps" data-testid="setup-step-list">
      {steps.map((text, index) => {
        const state: StepState =
          index < current ? "done" : index > current ? "waiting" : failed ? "failed" : "running";
        return (
          <li
            key={text}
            data-state={state}
            aria-current={state === "running" ? "step" : undefined}
            aria-label={`${text}, ${state}`}
          >
            <span className="s-step-mark" aria-hidden="true">
              {state === "done" ? <CheckIcon /> : state === "failed" ? <CloseIcon /> : null}
            </span>
            <span>
              {text}
              {details?.[index] && <span className="s-step-detail">{details[index]}</span>}
            </span>
            <span className="s-step-time">
              {state === "running" && elapsed >= 10 ? `${elapsed} s` : ""}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Note({
  tone,
  lead,
  children,
}: {
  tone?: "warn" | "danger";
  lead?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className="b-note"
      data-tone={tone}
      role={tone === "danger" ? "alert" : "status"}
      data-testid="setup-note"
    >
      {tone ? <WarnIcon /> : <ClockIcon />}
      <div>
        <p>
          {lead && <b>{lead}</b>}
          {lead && children ? " " : null}
          {children}
        </p>
      </div>
    </div>
  );
}

type Tone = "ok" | "warn" | "danger" | undefined;

/** What the look found: a mark, a title, at most five facts. */
function Found({
  mark,
  tone,
  heading,
  facts,
  children,
}: {
  mark: ReactNode;
  tone?: Tone;
  heading: string;
  facts?: Array<[string, string]>;
  children?: ReactNode;
}) {
  return (
    <>
      <div className="s-found" data-testid="setup-found">
        <span className="empty-mark" data-tone={tone} aria-hidden="true">
          {mark}
        </span>
        <h3>{heading}</h3>
        {facts && (
          <dl className="facts">
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      {children}
    </>
  );
}

function Lede({ children }: { children: ReactNode }) {
  return <p className="s-lede">{children}</p>;
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="s-hint">{children}</p>;
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="s-actions">{children}</div>;
}

function Primary({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      className="button"
      data-variant="primary"
      data-size="lg"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Quiet({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" className="button" data-variant="quiet" data-size="lg" onClick={onClick}>
      {children}
    </button>
  );
}

function SmallLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" className="button" data-variant="quiet" data-size="sm" onClick={onClick}>
      {children}
    </button>
  );
}

function ExternalLink({ children, href }: { children: ReactNode; href: string }) {
  return (
    <a
      className="button"
      data-variant="quiet"
      data-size="sm"
      href={href}
      target="_blank"
      rel="noreferrer noopener"
    >
      {children}
    </a>
  );
}

function HowToUpdate() {
  return (
    <details className="b-disclosure s-disclosure">
      <summary>How to update</summary>
      <div className="b-disclosure-body">
        <CommandLine command="openclaw update" label="Copy update command" />
        <Hint>Run it yourself when you're ready.</Hint>
      </div>
    </details>
  );
}

const SERVICE_WORDS: Record<LookService, string> = {
  launchagent: "LaunchAgent",
  "launchagent-stopped": "LaunchAgent, stopped",
  systemd: "systemd user service",
  "systemd-stopped": "systemd user service, stopped",
  none: "No matching service reported",
};

/** A fact the look established, or "Not reported". */
const NOT_REPORTED = "Not reported";
const serviceWords = (service: LookService | null) =>
  service ? SERVICE_WORDS[service] : NOT_REPORTED;

function runningFacts(look: SetupLook): Array<[string, string]> {
  return [
    ["Version", look.version ?? NOT_REPORTED],
    ["Profile", look.profile ?? NOT_REPORTED],
    [
      "Listens",
      look.listens === "loopback"
        ? "Configured for loopback"
        : look.listens === "lan"
          ? "Configured for LAN"
          : NOT_REPORTED,
    ],
    ["Service", serviceWords(look.service)],
  ];
}

/** What Connect does, said only as far as it is true for this device. */
const CONNECT_HINT: Record<NonNullable<SetupLook["access"]>, string> = {
  new: "Clawtrate asks for read access. The gateway may ask its owner to approve this device.",
  paired: "This device has a saved pairing for this address. Clawtrate asks for read access.",
};

/**
 * With local connect: what Connect does, where this device can't hold full control, or is
 * already paired there. Where it can, the consent line above Connect says it instead.
 */
const LOCAL_HINT: Record<NonNullable<SetupLook["access"]>, string> = {
  new: "Clawtrate asks for read access. OpenClaw may ask its owner to approve this device.",
  paired: "This device is already paired with it. Clawtrate connects with that pairing.",
};

/** The heading of the offer local connect makes, and the line under it: what its check found. */
export const LOCAL_FOUND_HEADING = "Found your OpenClaw settings on this Mac";
export const LOCAL_FOUND_LINE = "What is listening at the port they name matches them.";

/**
 * This computer's gateway, its socket matched to this account's OpenClaw profile by the host
 * (local connect): Connect is the one step, with the consent line above it where this device
 * asks for full control.
 */
function LocalConnect({
  look,
  full,
  onConnect,
}: {
  look: SetupLook;
  full: boolean;
  /** Called as Connect is pressed, before the host is asked. */
  onConnect?: () => void;
}) {
  const send = useCommand();
  const asksFull = full && look.access !== "paired";
  // A press that lands as Connect appears was aimed at what was there before: nothing happens.
  const shownAt = useRef<number | null>(null);
  useEffect(() => {
    shownAt.current = performance.now();
  }, []);
  const connect = () => {
    if (shownAt.current === null || performance.now() - shownAt.current < CONNECT_ARM_MS) return;
    onConnect?.();
    void send({ type: "setupConnect" });
  };
  return (
    <>
      <Lede>{LOCAL_FOUND_LINE}</Lede>
      {asksFull && <FullControlConsent />}
      <Actions>
        <Primary onClick={connect}>Connect</Primary>
      </Actions>
      {!asksFull && <Hint>{LOCAL_HINT[look.access ?? "new"]}</Hint>}
    </>
  );
}

/** Other services and profiles the look saw: named, never used. */
function Others({ others, onAdvanced }: { others: string[]; onAdvanced: () => void }) {
  if (others.length === 0) return null;
  return (
    <>
      <Note>{`Other OpenClaw services or profile folders reported here: ${others.join(", ")}.`}</Note>
      <p className="s-links">
        <SmallLink onClick={onAdvanced}>Advanced</SmallLink>
      </p>
    </>
  );
}

const CANT_TELL: Record<string, string> = {
  timeout: "The look didn't finish in time.",
  shape: "Clawtrate couldn't read the OpenClaw result.",
  "no-answer": "Clawtrate couldn't read a gateway answer.",
  "not-set-up": "OpenClaw didn't report a config file for this profile.",
  endpoint:
    "Clawtrate couldn't confirm where this gateway answers, so it doesn't connect to it by itself. Use Advanced.",
  "read-only":
    "This version of OpenClaw can change its own installation whenever one of its commands runs, so Clawtrate doesn't run it to look. Use Advanced with the gateway's address and token.",
  settings:
    "Clawtrate can't use OpenClaw's settings on this Mac to connect by itself. Use Advanced.",
  tls: "These settings may require a secure address. Use Advanced to connect with the gateway's address.",
};

/** Which fact local connect's proof refused, when the host said (`ProofRefusalKind`). */
const proofKind = (reason: string | null): ProofRefusalKind | null =>
  reason !== null && Object.hasOwn(PROOF_REFUSAL_LINES, reason)
    ? (reason as ProofRefusalKind)
    : null;

/** What local connect's proof refused, in its own words, at this port. */
function refusalWords(reason: string | null, port: number | null): string {
  const kind = proofKind(reason);
  return kind
    ? PROOF_REFUSAL_LINES[kind](port)
    : `Clawtrate couldn't verify what is listening at port ${port}.`;
}

/** Why local connect didn't offer a gateway that answered: nothing was sent to it. */
const unverifiedWords = (look: SetupLook) =>
  `${refusalWords(look.reason, look.port)} Clawtrate doesn't connect to it by itself. Use Advanced, or look again.`;

/** The found card and actions for each result of the look (§6). */
function LookResult({
  look,
  offer,
  onAdvanced,
  onAnother,
  onInstall,
  confirming,
  full,
}: {
  look: SetupLook;
  offer: NonNullable<HostInfo["setup"]>;
  onAdvanced: () => void;
  onAnother: () => void;
  onInstall: () => void;
  confirming: boolean;
  /** This device asks for full control at a new pairing (`HostInfo.fullControl`). */
  full: boolean;
}) {
  const send = useCommand();
  const lookAgain = () => void send({ type: "setupLook" });
  const advanced = <Primary onClick={onAdvanced}>Use Advanced</Primary>;
  switch (look.outcome) {
    case "running":
      if (offer.local)
        return (
          <Found mark={<CheckIcon />} tone="ok" heading={LOCAL_FOUND_HEADING}>
            <LocalConnect look={look} full={full} />
          </Found>
        );
      return (
        <Found
          mark={<CheckIcon />}
          tone="ok"
          heading="OpenClaw is running"
          facts={runningFacts(look)}
        >
          {offer.pair ? (
            <>
              <Actions>
                <button
                  type="button"
                  className="button"
                  data-variant="primary"
                  data-size="lg"
                  aria-disabled={confirming || undefined}
                  onClick={() => {
                    if (!confirming) void send({ type: "setupConnect" });
                  }}
                >
                  Connect read-only
                </button>
              </Actions>
              <Hint>{CONNECT_HINT[look.access ?? "new"]}</Hint>
            </>
          ) : (
            <>
              <Note>
                Pairing needs the desktop app, which asks you first. In this web preview, use
                Advanced.
              </Note>
              <Actions>{advanced}</Actions>
            </>
          )}
        </Found>
      );
    case "untested":
      return (
        <Found
          mark={<CheckIcon />}
          tone="ok"
          heading="OpenClaw is running"
          facts={runningFacts(look)}
        >
          <Note tone="warn">
            {`OpenClaw ${look.version} isn't the version this ${PRODUCT_NAME} is tested with (${TESTED_OPENCLAW_VERSION}). Use Advanced to try connecting.`}
          </Note>
          <Actions>{advanced}</Actions>
          <HowToUpdate />
        </Found>
      );
    case "too-old":
      return (
        <Found
          mark={<CloseIcon />}
          tone="danger"
          heading="This OpenClaw is too old for automatic setup"
        >
          <Lede>{`OpenClaw ${look.version} is below the version this ${PRODUCT_NAME} offers for automatic setup (${OLDEST_OPENCLAW_VERSION}). Update it, then look again.`}</Lede>
          <Actions>
            <Primary onClick={lookAgain}>Look again</Primary>
          </Actions>
          <HowToUpdate />
        </Found>
      );
    case "unverified":
      return (
        <Found mark={<WarnIcon />} tone="warn" heading="OpenClaw settings found">
          <Lede>{unverifiedWords(look)}</Lede>
          <Actions>
            {advanced}
            <Quiet onClick={lookAgain}>Look again</Quiet>
          </Actions>
        </Found>
      );
    case "stopped":
      return (
        <Found
          mark={<PauseIcon />}
          heading="OpenClaw is installed but not running"
          facts={[
            // Local connect reads settings, not the program or its service.
            ...(offer.local
              ? []
              : ([
                  ["Installed program", look.version ?? NOT_REPORTED],
                  ["Service", serviceWords(look.service)],
                ] as Array<[string, string]>)),
            ["Port", `No gateway answered on port ${look.port}`],
          ]}
        >
          <Lede>Start OpenClaw yourself, then look again.</Lede>
          <Actions>
            <Primary onClick={lookAgain}>Look again</Primary>
          </Actions>
          <p className="s-links">
            <SmallLink onClick={onAdvanced}>Advanced</SmallLink>
          </p>
        </Found>
      );
    case "program-missing":
      return (
        <Found
          mark={<WarnIcon />}
          tone="warn"
          heading="OpenClaw seems to be set up here, but Clawtrate can't find its program"
        >
          <Lede>
            Clawtrate looked in the usual places. If you installed OpenClaw somewhere else, use
            Advanced, or run <code>openclaw gateway status</code> here to see where it is.
          </Lede>
          <p className="s-links">
            <SmallLink onClick={onAdvanced}>Advanced</SmallLink>
          </p>
        </Found>
      );
    case "cant-tell":
      return (
        <Found
          mark={<WarnIcon />}
          tone="warn"
          heading={
            // TLS on: the settings were read, and local connect has no Connect for them.
            look.reason === "tls"
              ? "OpenClaw settings found"
              : "Clawtrate couldn't tell what is on this computer"
          }
        >
          <Lede>{CANT_TELL[look.reason ?? "shape"]}</Lede>
          <Actions>
            {advanced}
            <Quiet onClick={lookAgain}>Look again</Quiet>
          </Actions>
        </Found>
      );
    case "cant-run":
      return (
        <Found mark={<WarnIcon />} tone="warn" heading="Clawtrate couldn't run OpenClaw here">
          <Lede>
            Clawtrate found OpenClaw's program, but it didn't start. Check that OpenClaw runs here,
            or use Advanced.
          </Lede>
          <Actions>
            {advanced}
            <Quiet onClick={lookAgain}>Look again</Quiet>
          </Actions>
        </Found>
      );
    case "not-token":
      return (
        <Found mark={<WarnIcon />} tone="warn" heading="This gateway uses another way to sign in">
          <Lede>Clawtrate connects by itself only to gateways that use a token. Use Advanced.</Lede>
          <p className="s-links">
            <SmallLink onClick={onAdvanced}>Advanced</SmallLink>
          </p>
        </Found>
      );
    case "not-found":
      if (offer.install)
        return (
          <Found mark={<WarnIcon />} tone="warn" heading="Clawtrate didn't find OpenClaw here">
            {look.leftover && (
              <Hint>
                An earlier setup attempt didn't finish. Clawtrate checks its files before trying
                again.
              </Hint>
            )}
            <div className="s-actions s-install-actions">
              <button
                type="button"
                className="button"
                data-variant="primary"
                data-size="lg"
                aria-disabled={confirming || undefined}
                onClick={() => {
                  if (!confirming) onInstall();
                }}
              >
                Set up OpenClaw here
              </button>
              <InfoTip id="setup-install-info" about="setting up OpenClaw" />
            </div>
            <InfoCard id="setup-install-info">
              Clawtrate downloads OpenClaw {INSTALL_OPENCLAW_VERSION} from npm and Node.js{" "}
              {INSTALL_NODE_VERSION} from nodejs.org. It checks both against fingerprints built into
              this version. OpenClaw's installer then fetches dependencies from npm. Clawtrate
              doesn't verify those downloads. Their code runs with your account's permissions. The
              program goes in Clawtrate's app data. The gateway uses the clawtrate profile and
              starts when you log in. Clawtrate connects this Mac with full control. Other devices
              won't find the gateway automatically unless you enable discovery. To remove OpenClaw,
              use its uninstall for the clawtrate profile and remove the program from Clawtrate's
              app data.
            </InfoCard>
            <p className="s-links">
              <SmallLink onClick={onAdvanced}>Advanced</SmallLink>
            </p>
          </Found>
        );
      return (
        <Found mark={<PlusIcon />} heading="Clawtrate didn't find OpenClaw here">
          <Lede>
            Setting OpenClaw up from Clawtrate isn't in this version. Install it with OpenClaw's own
            instructions, then look again.
          </Lede>
          <Actions>
            <Primary onClick={lookAgain}>Look again</Primary>
            <Quiet onClick={onAnother}>It runs on another computer</Quiet>
          </Actions>
          <p className="s-links">
            <ExternalLink href={INSTALL_DOCS}>OpenClaw's own install instructions</ExternalLink>
          </p>
        </Found>
      );
    case "windows":
      return (
        <Found mark={<PlusIcon />} heading="Use Advanced on Windows">
          <Lede>
            Clawtrate can't yet look for OpenClaw on Windows. It doesn't set OpenClaw up on Windows
            either: OpenClaw's Windows installer can change Node.js or PATH and installs OpenClaw
            globally.
          </Lede>
          <Actions>
            {advanced}
            <button type="button" className="button" data-size="lg" onClick={onAnother}>
              Use another computer
            </button>
          </Actions>
          <p className="s-links">
            <ExternalLink href={INSTALL_DOCS}>OpenClaw's own install instructions</ExternalLink>
          </p>
        </Found>
      );
  }
}

/** Connect's failures (§7), in fixed copy. */
const FAILURES: Record<
  SetupFailureKind,
  {
    lead: string;
    text?: (port: number | null, exit: number | null) => string;
    next: "retry" | "look" | "back" | "advanced" | "bots";
    step: number;
  }
> = {
  "code-failed": {
    lead: "Couldn't make a one-time code.",
    text: (_port, exit) =>
      exit === null
        ? ""
        : exit === 0
          ? "OpenClaw didn't return a usable setup code."
          : `OpenClaw exited with code ${exit}.`,
    next: "retry",
    step: 0,
  },
  "code-refused": {
    lead: "The one-time code didn't work.",
    text: () => "Clawtrate makes a new one when you try again.",
    next: "retry",
    step: 1,
  },
  grant: {
    lead: "The gateway granted something other than read access, so Clawtrate disconnected.",
    next: "back",
    step: 1,
  },
  unreachable: {
    lead: "",
    text: () => "The gateway may have just stopped.",
    next: "look",
    step: 1,
  },
  changed: {
    lead: "This changed since you looked.",
    text: () => "Look again.",
    next: "look",
    step: 0,
  },
  unverified: {
    lead: "",
    text: () => "No credential was sent to it. Use Advanced, or look again.",
    next: "advanced",
    step: 0,
  },
  unanswered: {
    lead: "",
    text: () =>
      "It may have just stopped, or be running on settings changed since it started, such as a secure address. Use Advanced, or look again.",
    next: "advanced",
    step: 1,
  },
  "no-dialog": {
    lead: "Pairing needs the desktop app, which asks you first.",
    text: () => "In this web preview, use Advanced.",
    next: "advanced",
    step: 0,
  },
  refused: { lead: "", next: "advanced", step: 0 },
  bots: {
    lead: "Connected, but Clawtrate couldn't read your bots.",
    text: () => "Try again, or go back.",
    next: "bots",
    step: 2,
  },
  cleanup: {
    lead: "Clawtrate couldn't close the connection it started.",
    text: () => "Go back to try again.",
    next: "back",
    step: 1,
  },
  other: {
    lead: "Clawtrate couldn't connect to the gateway.",
    text: () => "Try again, or use Advanced.",
    next: "retry",
    step: 1,
  },
};

/** Connect's steps: a new pairing, or a device that is already paired there. */
const CONNECT_STEPS: Record<NonNullable<SetupLook["access"]>, string[]> = {
  new: ["Making a one-time code", "Requesting read access", "Loading your bots"],
  paired: ["Checking the gateway", "Requesting read access", "Loading your bots"],
};
/** And with local connect (setup-effortless.md §3). */
const LOCAL_CONNECT_STEPS: Record<NonNullable<SetupLook["access"]>, string[]> = {
  new: ["Checking it matches OpenClaw's settings", "Pairing this Mac", "Loading your bots"],
  paired: ["Checking it matches OpenClaw's settings", "Connecting this Mac", "Loading your bots"],
};

/** Why a run that must look in a sandbox couldn't use the one it was given, in words. */
const REFUSED: Record<SetupRefusal, string> = {
  missing: "none was given to this run.",
  file: "its description isn't in a private folder of yours under the system's temporary root, reached without links, or has the wrong shape.",
  home: "its home and working folder must be outside the account's home.",
  state: "its state folder or config didn't pass the run's checks.",
  pairing: "it pairs only in its pairing scenario.",
};
const LOOK_STEPS = ["Finding OpenClaw", "Checking its version", "Asking the gateway"];
const LOCAL_LOOK_STEPS = ["Reading OpenClaw's settings", "Checking it matches OpenClaw's settings"];

/** How long Connect ignores presses after it appears: they were aimed at what was there. */
export const CONNECT_ARM_MS = 500;
/**
 * How long the first screen waits, with nothing on it to press, for the host's own look at
 * start. Then it asks its question, and a result that comes later doesn't take its place.
 */
export const START_WAIT_MS = 3_000;

/** The look's result the first screen offers by itself: this computer's gateway, matched to its profile. */
const offeredHere = (offer: NonNullable<HostInfo["setup"]>, setup: SetupState) =>
  offer.local === true &&
  setup.unasked &&
  setup.phase === "found" &&
  setup.look?.outcome === "running";

/** Setting OpenClaw up (§10): the steps, in the host's order. */
const INSTALL_STEPS = [
  `Download and check OpenClaw ${INSTALL_OPENCLAW_VERSION}`,
  "Install Node.js and OpenClaw",
  "Set up the gateway",
  "Start and check",
];

/** Onboarding's failure classes in words (§6, "Start OpenClaw"; §10). */
const CLASSIFICATION: Record<OnboardClassification, string> = {
  "service-missing": "The service isn't installed.",
  "startup-blocked": "OpenClaw couldn't start the gateway.",
  "not-listening": "Nothing is listening yet.",
  "service-stopped": "The service is installed but stopped.",
  "auth-mismatch": "The gateway's sign-in settings don't match.",
  "module-missing": "Part of OpenClaw's program is missing.",
  "systemd-user-unavailable": "This session can't run a systemd user service.",
};

/** Each install failure's cause, in fixed copy. */
function installCause(failure: InstallFailure): string {
  switch (failure.kind) {
    case "exists":
      return "Clawtrate won't replace it.";
    case "write":
      return "Clawtrate couldn't read or write a file it needs. Check that there is space and that its app data can be written.";
    case "user-service":
      return "Setting OpenClaw up here needs a running systemd user manager, as a desktop login has.";
    case "download":
      return "The download didn't finish.";
    case "download-short":
      return "The download ended before all its bytes arrived.";
    case "download-space":
      return "Clawtrate ran out of space while saving a download.";
    case "fingerprint":
      return "A download didn't match its expected fingerprint. Setup stopped before extracting either archive.";
    case "unpack":
      return "Clawtrate couldn't unpack a checked download.";
    case "installer-changed":
      return "The checked installer isn't the one this version of Clawtrate expects.";
    case "installer":
      return "The installer didn't finish successfully.";
    case "no-program":
      return "Clawtrate couldn't find the installed OpenClaw program, or it isn't the checked one.";
    case "node-not-checked":
      return "Clawtrate couldn't confirm the installer would use the checked Node.js.";
    case "onboard":
      return failure.classification
        ? CLASSIFICATION[failure.classification]
        : failure.exitCode === null || failure.exitCode === 0
          ? "OpenClaw's setup didn't report a gateway Clawtrate can use."
          : `OpenClaw's setup stopped (exit ${failure.exitCode}).`;
    case "service":
      return "Clawtrate couldn't confirm the gateway's user service was installed.";
    case "service-appeared":
      return "A Clawtrate service appeared on this computer while setting up; Clawtrate left it as it is.";
    case "not-answering":
      return "Clawtrate couldn't confirm the new gateway was running on its chosen port.";
    case "expired":
      return "Try again.";
    case "changed":
    case "unchecked":
      return "Look again.";
  }
}

/** What a failed attempt left, said after its cause. */
const CLEANUP: Record<InstallFailure["cleanup"], string> = {
  none: "",
  removed: " Clawtrate removed this attempt's program files and install record.",
  unproven:
    " Check the clawtrate profile and Clawtrate’s app data. Some setup files may still be there.",
  kept: " Clawtrate kept the gateway files in the clawtrate profile and its app data.",
};

/** A failure before the first step: its own lead, and no step drawn as failed. */
const BEFORE: Partial<Record<InstallFailure["kind"], string>> = {
  exists: "A clawtrate folder, service or install record already exists.",
  write: "Clawtrate couldn't prepare the install.",
  "user-service": "This session can't run a systemd user service.",
  changed: "This changed since you looked.",
  unchecked: "Clawtrate couldn't check whether OpenClaw was already set up.",
  expired: "This setup confirmation expired.",
};

/** The typed record of a failed step (§10): the step, the error category, the exit code. */
const CATEGORY: Record<InstallFailure["kind"], string> = {
  exists: "Already set up",
  write: "Write",
  "user-service": "User service manager",
  download: "Download",
  "download-short": "Download incomplete",
  "download-space": "No space",
  fingerprint: "Fingerprint",
  unpack: "Unpack",
  "installer-changed": "Installer not expected",
  installer: "Installer",
  "no-program": "Installed program",
  "node-not-checked": "Node.js not checked",
  onboard: "Gateway setup",
  service: "User service",
  "service-appeared": "Service appeared",
  "not-answering": "No answer",
  changed: "Changed",
  unchecked: "Not checked",
  expired: "Expired",
};

/** "Setting up OpenClaw" (§10, F-502): the steps, and a failed step with its cause and record. */
function Installing({
  setup,
  onBack,
  onRecover,
}: {
  setup: SetupState;
  onBack: () => void;
  onRecover: (action: InstallAction) => void;
}) {
  const send = useCommand();
  const install = setup.install ?? { step: 0, nodeChecked: false, failure: null };
  const failure = setup.phase === "install-failed" ? install.failure : null;
  const current = failure ? failure.step : install.step;
  const details = [null, install.nodeChecked ? `Node.js ${INSTALL_NODE_VERSION}, checked` : null];
  let lead = "";
  if (failure && failure.step < 0) lead = BEFORE[failure.kind] ?? "Setup couldn't start.";
  else if (failure?.kind === "changed") lead = BEFORE.changed!;
  else if (failure) lead = `${INSTALL_STEPS[failure.step] ?? INSTALL_STEPS[0]} failed.`;
  const again = failure?.kind === "changed" || failure?.kind === "unchecked";
  return (
    <>
      {(failure || install.recovery) && <Back onBack={onBack} />}
      <Mark />
      <Title id="setup-title">
        {install.recovery ? "Finish setting up OpenClaw" : "Setting up OpenClaw"}
      </Title>
      {install.recovery && (
        <Lede>
          {install.recovery === "inspect"
            ? "Setup stopped before Clawtrate could confirm the gateway. Files may remain in the clawtrate profile and Clawtrate's app data."
            : "Clawtrate set up the gateway profile. Continue to finish setting up its service."}
        </Lede>
      )}
      <Steps steps={INSTALL_STEPS} current={current} failed={!!failure} details={details} />
      {failure && (
        <>
          <Note tone="danger" lead={lead}>
            {installCause(failure)}
            {failure.kind === "service" && failure.cleanup === "removed"
              ? " Clawtrate removed this attempt’s gateway profile and program files."
              : CLEANUP[failure.cleanup]}
          </Note>
          {failure.step >= 0 && failure.kind !== "changed" && (
            <details className="b-disclosure s-disclosure" data-testid="setup-install-details">
              <summary>Show details</summary>
              <div className="b-disclosure-body">
                <dl className="facts">
                  <div>
                    <dt>Step</dt>
                    <dd>{INSTALL_STEPS[failure.step] ?? "Before the first step"}</dd>
                  </div>
                  <div>
                    <dt>Error</dt>
                    <dd>
                      {failure.classification
                        ? `${CATEGORY[failure.kind]}: ${failure.classification}`
                        : CATEGORY[failure.kind]}
                    </dd>
                  </div>
                  <div>
                    <dt>Exit code</dt>
                    <dd>{failure.exitCode === null ? "None" : String(failure.exitCode)}</dd>
                  </div>
                </dl>
              </div>
            </details>
          )}
          {!install.recovery && (
            <Actions>
              {failure.retry && (
                <Primary onClick={() => void send({ type: "setupInstall" })}>Try again</Primary>
              )}
              {again ? (
                <Primary onClick={() => void send({ type: "setupLook" })}>Look again</Primary>
              ) : (
                !failure.retry && (
                  <Primary onClick={() => void send({ type: "setupLook" })}>Try again</Primary>
                )
              )}
            </Actions>
          )}
        </>
      )}
      {install.recovery && (
        <Actions>
          {install.recovery === "inspect" ? (
            <Primary onClick={() => void send({ type: "setupLook" })}>Look again</Primary>
          ) : (
            <Primary onClick={() => onRecover("continue")}>Continue</Primary>
          )}
          {install.recovery === "replace" && (
            <Quiet onClick={() => onRecover("replace")}>Remove and start again</Quiet>
          )}
        </Actions>
      )}
    </>
  );
}

/** A screen's identity, so that a new one takes focus and is announced. */
function screenKey(
  view: SetupView,
  setup: SetupState,
  offer: NonNullable<HostInfo["setup"]>,
): string {
  if (setup.phase === "install-failed" && setup.install?.recovery)
    return `install-recovery:${setup.install.recovery}`;
  if (view === "first" && offeredHere(offer, setup)) return "first:found";
  if (view === "first" && setup.unasked && setup.phase === "looking") return "first:waiting";
  if (view !== "here") return view;
  return `${setup.phase}:${setup.look?.outcome ?? ""}:${setup.failure?.kind ?? setup.install?.failure?.kind ?? ""}`;
}

export function SetupFlow({
  view,
  onView,
  setup,
  connection,
  info,
}: {
  view: SetupView;
  onView: (view: SetupView) => void;
  setup: SetupState;
  connection: ConnectionState;
  info: HostInfo;
}) {
  const send = useCommand();
  const offer = info.setup!;
  const root = useRef<HTMLDivElement>(null);
  const [announced, setAnnounced] = useState("");
  // The host's own look at start: the first screen waits for it, with nothing to press, for at
  // most START_WAIT_MS. Nothing that grants anything appears where another control was: once the
  // question is on screen, a gateway found later is offered only after This computer.
  // The first screen's wait for the host's own look at start, resolved exactly once: to the
  // offer, when the look matched a gateway to its profile in time, or to the question, at its end or after
  // START_WAIT_MS, whichever comes first. The timer ends with the wait, so an offer shown in
  // time stays; and once the question is shown, no offer takes its place.
  const [initial, setInitial] = useState<"waiting" | "offer" | "question">(() =>
    offer.local === true && setup.unasked && setup.phase === "looking"
      ? "waiting"
      : offeredHere(offer, setup)
        ? "offer"
        : "question",
  );
  if (initial === "waiting" && !(setup.unasked && setup.phase === "looking"))
    setInitial(offeredHere(offer, setup) ? "offer" : "question");
  useEffect(() => {
    if (initial !== "waiting") return;
    const timer = setTimeout(
      () => setInitial((now) => (now === "waiting" ? "question" : now)),
      START_WAIT_MS,
    );
    return () => clearTimeout(timer);
  }, [initial]);
  const holding = view === "first" && initial === "waiting";
  const offerHere = view === "first" && initial === "offer" && offeredHere(offer, setup);
  const key = holding
    ? "first:waiting"
    : offerHere
      ? "first:found"
      : view === "first" && !setup.install?.recovery
        ? "first"
        : screenKey(view, setup, offer);
  const shown = useRef<string | null>(null);
  useEffect(() => {
    const first = shown.current === null;
    shown.current = key;
    const title = root.current?.querySelector<HTMLElement>("[data-s-title]");
    if (!title) return;
    setAnnounced(title.textContent ?? "");
    // Not on launch: nothing had focus to lose.
    if (!first) title.focus();
  }, [key]);

  const installHere = (action?: InstallAction) => {
    onView("here");
    void send(action ? { type: "setupInstall", action } : { type: "setupInstall" });
  };
  const toFirst = () => {
    if (view === "here") void send(leaveLook(setup));
    onView("first");
  };
  const lookHere = () => {
    onView("here");
    // A look the host never started (this window's commands refused) shows no progress.
    send({ type: "setupLook" }).catch(() => onView("first"));
  };
  const advanced = () => {
    if (view === "here") void send({ type: "setupReset" });
    onView("advanced");
  };
  const another = () => {
    if (view === "here") void send({ type: "setupReset" });
    onView("another");
  };
  // Back from a wait or a failure of Connect returns to what the look found.
  const backFromConnect = () => void send({ type: "setupCancel" });
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || view === "first" || setup.phase === "installing") return;
    event.preventDefault();
    // As each screen's Back: a refused sandbox's goes to the first question.
    if (setup.install?.recovery) return toFirst();
    if (
      view === "here" &&
      (setup.phase === "connecting" ||
        setup.phase === "install-failed" ||
        (setup.phase === "failed" && setup.failure?.kind !== "refused"))
    )
      backFromConnect();
    else toFirst();
  };

  let body: ReactNode;
  if (setup.phase === "install-failed" && setup.install?.recovery && view === "first") {
    body = <Installing setup={setup} onBack={toFirst} onRecover={installHere} />;
  } else if (holding) {
    body = <WaitingHere />;
  } else if (view === "first") {
    body = offerHere ? (
      <FoundHere
        look={setup.look!}
        full={info.fullControl === true}
        onConnect={() => onView("here")}
        onAnother={another}
        onAdvanced={advanced}
      />
    ) : (
      <FirstScreen offer={offer} onThis={lookHere} onAnother={another} onAdvanced={advanced} />
    );
  } else if (view === "another") {
    body = (
      <>
        <Back onBack={toFirst} />
        <Mark />
        <Title id="setup-title">Another computer</Title>
        <Lede>
          Reaching another computer with SSH isn't in this version of Clawtrate yet. Use Advanced
          with that gateway's address and a token.
        </Lede>
        <Actions>
          <Primary onClick={advanced}>Use Advanced</Primary>
        </Actions>
      </>
    );
  } else if (setup.phase === "installing" || setup.phase === "install-failed") {
    body = (
      <Installing
        setup={setup}
        onBack={setup.install?.recovery ? toFirst : backFromConnect}
        onRecover={installHere}
      />
    );
  } else if (setup.phase === "looking" || setup.phase === "idle") {
    body = (
      <>
        <Back onBack={toFirst} />
        <Mark />
        <Title id="setup-title">Looking on this computer</Title>
        <Steps steps={offer.local ? LOCAL_LOOK_STEPS : LOOK_STEPS} current={setup.step} />
        {setup.slow && (
          <p className="s-slow" role="status">
            Still looking. A gateway that has just started can take a while to answer.
          </p>
        )}
      </>
    );
  } else if (setup.phase === "failed" && setup.failure?.kind === "refused") {
    body = (
      <>
        <Back onBack={toFirst} />
        <Mark />
        <Title id="setup-title">On this computer</Title>
        <Found mark={<WarnIcon />} tone="warn" heading="Looking on this computer is off here">
          <Lede>
            {`This run can only look in a sandbox. ${PRODUCT_NAME} couldn't use this sandbox because ${REFUSED[(setup.failure.reason as SetupRefusal | null) ?? "file"]} Use Advanced.`}
          </Lede>
          <Actions>
            <Primary onClick={advanced}>Use Advanced</Primary>
          </Actions>
        </Found>
      </>
    );
  } else if (
    (setup.phase === "connecting" || setup.phase === "failed" || setup.phase === "done") &&
    connection.status !== "pairing"
  ) {
    const failure = setup.phase === "failed" ? setup.failure : null;
    const copy = failure ? FAILURES[failure.kind] : null;
    const lead =
      failure?.kind === "unreachable"
        ? `Nothing answered on port ${failure.port}.`
        : failure?.kind === "unanswered"
          ? `The gateway at port ${failure.port} didn't answer as OpenClaw's settings on this Mac say it would.`
          : failure?.kind === "unverified"
            ? refusalWords(failure.reason, failure.port)
            : (copy?.lead ?? "");
    body = (
      <>
        <Back onBack={backFromConnect} />
        <Mark />
        <Title id="setup-title">Connecting</Title>
        <Steps
          steps={(offer.local ? LOCAL_CONNECT_STEPS : CONNECT_STEPS)[setup.look?.access ?? "new"]}
          current={failure ? copy!.step : setup.step}
          failed={!!failure}
        />
        {failure && copy && (
          <>
            <Note tone="danger" lead={lead}>
              {copy.text?.(failure.port, failure.exitCode)}
            </Note>
            <Actions>
              {copy.next === "retry" && (
                <Primary onClick={() => void send({ type: "setupConnect" })}>Try again</Primary>
              )}
              {copy.next === "look" && (
                <Primary onClick={() => void send({ type: "setupLook" })}>Look again</Primary>
              )}
              {copy.next === "advanced" && <Primary onClick={advanced}>Use Advanced</Primary>}
              {(failure.kind === "unverified" || failure.kind === "unanswered") && (
                <Quiet onClick={() => void send({ type: "setupLook" })}>Look again</Quiet>
              )}
              {copy.next === "back" && <Primary onClick={backFromConnect}>Back</Primary>}
              {copy.next === "bots" && (
                <Primary onClick={() => void send({ type: "retry" })}>Try again</Primary>
              )}
            </Actions>
          </>
        )}
      </>
    );
  } else {
    const look = setup.look!;
    body = (
      <>
        <Back onBack={toFirst} />
        <Mark />
        <Title id="setup-title">On this computer</Title>
        <LookResult
          look={look}
          offer={offer}
          onAdvanced={advanced}
          onAnother={another}
          onInstall={installHere}
          confirming={setup.phase === "confirming"}
          full={info.fullControl === true}
        />
        <Others others={look.others} onAdvanced={advanced} />
      </>
    );
  }
  return (
    <div className="setup" ref={root} onKeyDown={onKeyDown} data-testid="setup" data-screen={key}>
      {body}
      <p className="visually-hidden" aria-live="polite">
        {announced}
      </p>
    </div>
  );
}

/** The first screen while the host's own look at start runs: nothing to press yet. */
function WaitingHere() {
  return (
    <>
      <header className="connect-brand">
        <img src={logoUrl} alt="" width={56} height={56} />
        <h1>{PRODUCT_NAME}</h1>
        <p>{SLOGAN}</p>
      </header>
      <h2 className="s-title s-question" id="setup-title" tabIndex={-1} data-s-title>
        Looking for OpenClaw on this Mac
      </h2>
    </>
  );
}

/**
 * The first screen when the host's own look found OpenClaw's settings on this Mac and matched
 * what listens at their port to that profile (local connect): that gateway first, with Connect,
 * and the other ways below it.
 */
function FoundHere({
  look,
  full,
  onConnect,
  onAnother,
  onAdvanced,
}: {
  look: SetupLook;
  full: boolean;
  onConnect: () => void;
  onAnother: () => void;
  onAdvanced: () => void;
}) {
  return (
    <>
      <header className="connect-brand">
        <img src={logoUrl} alt="" width={56} height={56} />
        <h1>{PRODUCT_NAME}</h1>
        <p>{SLOGAN}</p>
      </header>
      <h2 className="s-title s-question" id="setup-title" tabIndex={-1} data-s-title>
        {LOCAL_FOUND_HEADING}
      </h2>
      {/* Connect goes on to its steps on the screen for this computer. */}
      <LocalConnect look={look} full={full} onConnect={onConnect} />
      <p className="s-links">
        <SmallLink onClick={onAnother}>Another computer</SmallLink>
        <SmallLink onClick={onAdvanced}>Advanced</SmallLink>
      </p>
    </>
  );
}

function FirstScreen({
  offer,
  onThis,
  onAnother,
  onAdvanced,
}: {
  offer: NonNullable<HostInfo["setup"]>;
  onThis: () => void;
  onAnother: () => void;
  onAdvanced: () => void;
}) {
  // Up and Down move between the two rows, Home and End go to the ends (§2 "Input").
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button.b-choice")];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "ArrowDown"
        ? Math.min(at + 1, rows.length - 1)
        : event.key === "ArrowUp"
          ? Math.max(at - 1, 0)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? rows.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    rows[next]?.focus();
  };
  const row = (title: string, sub: string, onClick: () => void) => (
    <li>
      <button type="button" className="b-choice" onClick={onClick}>
        <span className="b-choice-text">
          <span className="b-choice-title">{title}</span>
          <span className="b-choice-sub">{sub}</span>
        </span>
        <ChevronIcon />
      </button>
    </li>
  );
  return (
    <>
      <header className="connect-brand">
        <img src={logoUrl} alt="" width={56} height={56} />
        <h1>{PRODUCT_NAME}</h1>
        <p>{SLOGAN}</p>
      </header>
      <h2 className="s-title s-question" id="setup-title" tabIndex={-1} data-s-title>
        Where does OpenClaw run?
      </h2>
      <ul className="b-choices" aria-labelledby="setup-title" onKeyDown={onKeyDown}>
        {row("This computer", "Clawtrate looks for OpenClaw here.", onThis)}
        {row(
          "Another computer",
          "A computer you reach with SSH, such as a server or a desktop at home.",
          onAnother,
        )}
      </ul>
      <p className="s-links">
        <SmallLink onClick={onAdvanced}>Advanced</SmallLink>
      </p>
      <Hint>
        {offer.platform === "win32"
          ? "New to OpenClaw? Clawtrate doesn't set it up on Windows. Use Advanced with a gateway on a Mac or a Linux computer."
          : "New to OpenClaw? Choose where it should run, and Clawtrate says what it finds there."}
      </Hint>
    </>
  );
}
