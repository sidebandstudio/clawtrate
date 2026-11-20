import { PROJECT_URL, type Run } from "@clawtrate/core";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { useBridge, useClawtrateState } from "../bridge.tsx";
import { useInvitationReplies } from "../bridge.tsx";
import "./star.css";

type NoticeState = "ask" | "busy" | "success" | "failure" | "open-error";
export const StarScene = createContext<NoticeState | null>(null);
const openError = "Couldn't open GitHub. Try again from About.";

export function ProjectLink({
  about = false,
  onResult,
}: {
  about?: boolean;
  onResult?: (opened: boolean) => void;
}) {
  const bridge = useBridge();
  const [failed, setFailed] = useState(false);
  return (
    <div className="star-link">
      <a
        href={PROJECT_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Open GitHub to star Clawtrate"
        onClick={(event) => {
          event.preventDefault();
          const answer = (opened: boolean) => {
            setFailed(!opened);
            onResult?.(opened);
          };
          if (bridge.openProjectPage)
            void bridge.openProjectPage().then(answer, () => answer(false));
          else {
            try {
              window.open(PROJECT_URL, "_blank", "noopener,noreferrer");
              answer(true);
            } catch {
              answer(false);
            }
          }
        }}
      >
        {about ? "Star Clawtrate on GitHub" : "Open GitHub"}
      </a>
      <small>Opens in your browser.</small>
      {about && failed && <p role="status">{openError}</p>}
    </div>
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
              {bridge.starWithCli && (
                <div className="star-link">
                  <button
                    type="button"
                    className="button"
                    disabled={notice === "busy"}
                    onClick={async () => {
                      setNotice("busy");
                      const ok = await bridge.starWithCli!().catch(() => false);
                      setNotice((current) =>
                        current === "busy" ? (ok ? "success" : "failure") : current,
                      );
                      if (
                        element.current?.isConnected &&
                        !element.current.closest("[inert]") &&
                        (element.current.contains(document.activeElement) ||
                          document.activeElement === document.body)
                      )
                        field.current?.focus();
                    }}
                  >
                    Star with GitHub CLI
                  </button>
                  <small>
                    Stars sidebandstudio/clawtrate as the account the GitHub CLI is signed in to on
                    this computer.
                  </small>
                </div>
              )}
            </>
          )}
          {notice !== "success" && notice !== "busy" && notice !== "open-error" && (
            <ProjectLink
              onResult={(ok) => {
                if (!element.current?.isConnected) return;
                if (ok) close();
                else {
                  setNotice("open-error");
                  field.current?.focus();
                }
              }}
            />
          )}
          {notice !== "success" && (
            <button type="button" className="link-button" onClick={close}>
              Dismiss
            </button>
          )}
        </section>
      )}
    </>
  );
}
