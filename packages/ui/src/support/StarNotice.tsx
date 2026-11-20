import { PROJECT_URL, type Run } from "@clawtrate/core";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useId,
  type MouseEvent,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { useBridge, useClawtrateState, useInvitationReplies } from "../bridge.tsx";
import { ExternalIcon } from "../icons.tsx";
import "./star.css";

type NoticeState = "ask" | "busy" | "success" | "failure" | "open-error";
export const StarScene = createContext<NoticeState | null>(null);
const openError = "Couldn't open GitHub. Try again from About.";

export function ProjectLink({
  about = false,
  primary = false,
  take,
  onResult,
}: {
  about?: boolean;
  primary?: boolean;
  take?: () => boolean;
  onResult?: (opened: boolean) => void;
}) {
  const bridge = useBridge();
  const pending = useRef(false);
  const [failed, setFailed] = useState(false);
  async function open(event: MouseEvent<HTMLAnchorElement>) {
    if (event.type === "auxclick" && event.button !== 1) return;
    event.preventDefault();
    if (pending.current || (take && !take())) return;
    pending.current = true;
    let opened = false;
    try {
      if (bridge.openProjectPage) opened = await bridge.openProjectPage();
      else {
        window.open(PROJECT_URL, "_blank", "noopener,noreferrer");
        opened = true;
      }
    } catch {
      // The platform refused the handoff.
    } finally {
      if (about) {
        pending.current = false;
        setFailed(!opened);
      }
      onResult?.(opened);
    }
  }
  const link = (
    <a
      href={PROJECT_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={about ? "star-about-link" : primary ? "button" : "star-browser-link"}
      data-variant={primary ? "primary" : undefined}
      title="Opens in your browser."
      aria-label={about ? undefined : "Open GitHub to star Clawtrate"}
      onClick={open}
      onAuxClick={open}
    >
      {about ? (
        <>
          Star Clawtrate on GitHub <ExternalIcon />
        </>
      ) : (
        "Open GitHub"
      )}
    </a>
  );
  return about ? (
    <div className="star-about">
      {link}
      {failed && <p role="status">{openError}</p>}
    </div>
  ) : (
    link
  );
}

function rendered(run: Run): boolean {
  return !!document.querySelector(`[data-reply-run="${CSS.escape(run.id)}"]`);
}

export function StarNotice({
  taskKey,
  field,
  active,
  covered,
}: {
  taskKey: string;
  field: RefObject<HTMLTextAreaElement | null>;
  active: boolean;
  covered: boolean;
}) {
  const bridge = useBridge();
  const { transcripts } = useClawtrateState();
  const invitationReplies = useInvitationReplies();
  const revision = useSyncExternalStore(
    invitationReplies.subscribe,
    () => invitationReplies.revision,
  );
  const scene = useContext(StarScene);
  const [notice, setNotice] = useState<NoticeState | null>(scene);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    const foreground =
      mounted.current &&
      active &&
      !document.hidden &&
      document.hasFocus() &&
      field.current?.checkVisibility();
    const blocked = covered || !!document.querySelector('[aria-modal="true"]');
    if (
      invitationReplies.observe(
        transcripts,
        foreground ? taskKey : null,
        rendered,
        undefined,
        blocked,
      )
    )
      setNotice("ask");
    mounted.current = true;
  }, [active, covered, field, invitationReplies, revision, taskKey, transcripts]);
  useEffect(() => {
    if (notice !== "success" || scene === "success") return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice, scene]);
  const element = useRef<HTMLElement>(null);
  const hintId = useId();
  const taken = useRef(false);
  const take = () => {
    if (taken.current) return false;
    taken.current = true;
    return true;
  };
  const restoreFocus = () => {
    if (
      element.current?.isConnected &&
      !element.current.closest("[inert]") &&
      (element.current.contains(document.activeElement) || document.activeElement === document.body)
    )
      field.current?.focus();
  };
  const close = () => {
    setNotice(null);
    field.current?.focus();
  };
  const message =
    notice === "success"
      ? "Starred. Thank you."
      : notice === "failure"
        ? "Couldn't star with the GitHub CLI."
        : notice === "open-error"
          ? openError
          : "";
  return (
    <>
      <span className="visually-hidden" role="status">
        {notice === "ask"
          ? "Enjoying Clawtrate? Clawtrate is open source. If it helped, consider starring it on GitHub."
          : message}
      </span>
      {notice && (
        <section
          ref={element}
          className="star-notice"
          aria-label="GitHub invitation"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          }}
        >
          {message && <p>{message}</p>}
          {(notice === "ask" || notice === "busy") && (
            <>
              <h3>Enjoying Clawtrate?</h3>
              <p>Clawtrate is open source. If it helped, consider starring it on GitHub.</p>
            </>
          )}
          {notice !== "success" && (
            <div className="star-actions">
              {(notice === "ask" || notice === "busy") && bridge.starWithCli && (
                <button
                  type="button"
                  className="button"
                  data-variant="primary"
                  disabled={notice === "busy"}
                  aria-describedby={hintId}
                  onClick={async () => {
                    if (!take()) return;
                    setNotice("busy");
                    const ok = await bridge.starWithCli!().catch(() => false);
                    if (!element.current?.isConnected) return;
                    if (!ok) taken.current = false;
                    restoreFocus();
                    setNotice((current) =>
                      current === "busy" ? (ok ? "success" : "failure") : current,
                    );
                  }}
                >
                  Star with GitHub CLI
                </button>
              )}
              {notice !== "busy" && notice !== "open-error" && (
                <ProjectLink
                  primary={!bridge.starWithCli || notice === "failure"}
                  take={take}
                  onResult={(ok) => {
                    if (!element.current?.isConnected) return;
                    restoreFocus();
                    setNotice(ok ? null : "open-error");
                  }}
                />
              )}
              <button type="button" className="link-button" onClick={close}>
                Dismiss
              </button>
            </div>
          )}
          {(notice === "ask" || notice === "busy") && bridge.starWithCli && (
            <p className="star-account" id={hintId}>
              Stars sidebandstudio/clawtrate as the account the GitHub CLI is signed in to on this
              computer.
            </p>
          )}
        </section>
      )}
    </>
  );
}
