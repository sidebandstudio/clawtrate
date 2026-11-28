import { Component, createRef, type ReactNode, type RefObject } from "react";

type Props = {
  children: ReactNode;
  /** The fallback's own class beside `empty`: where it must sit as its panel does (the Work drawer). */
  className?: string;
  /** Told when the panel fails and when it draws again, for what the shell does only while it shows. */
  onFailed?: (failed: boolean) => void;
  /** A way out that doesn't run through the failed panel: on a phone it may be the only one. */
  back?: { label: string; onClick: () => void };
  /**
   * The element the shell keeps focus in while this panel shows (the Work drawer's): the fallback
   * takes it over, and its Try again takes focus when the panel fails.
   */
  rootRef?: RefObject<HTMLElement | null>;
};

/** One panel that throws shows this in its place; the rail and the other panels stay. */
export class PanelBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };
  private readonly tryAgain = createRef<HTMLButtonElement>();

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  // Called after the fallback is drawn, on a panel's first draw too: the drawer's focus goes there.
  override componentDidCatch(): void {
    this.props.onFailed?.(true);
    if (this.props.rootRef) this.tryAgain.current?.focus();
  }

  override componentDidUpdate(_: Props, before: { failed: boolean }): void {
    // Said only once the panel has drawn again: a Try again that fails again never got here.
    if (before.failed && !this.state.failed) this.props.onFailed?.(false);
  }

  override componentWillUnmount(): void {
    if (this.state.failed) this.props.onFailed?.(false);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        className={this.props.className ? `empty ${this.props.className}` : "empty"}
        role="alert"
        data-testid="panel-failed"
        ref={this.props.rootRef as RefObject<HTMLDivElement | null> | undefined}
      >
        <div>
          <h1 tabIndex={-1}>Couldn't show this part</h1>
          <p>Something here stopped working. The rest of Clawtrate still works.</p>
          <div className="empty-actions">
            <button
              type="button"
              className="button"
              ref={this.tryAgain}
              onClick={() => this.setState({ failed: false })}
            >
              Try again
            </button>
            {this.props.back && (
              <button
                type="button"
                className="button"
                data-variant="quiet"
                onClick={this.props.back.onClick}
              >
                {this.props.back.label}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
}

/**
 * Runs `render` while this draws, not while its parent does, so what it throws reaches the
 * `PanelBoundary` between them: a section a hook builds during Settings' own render.
 */
export function Deferred({ render }: { render: () => ReactNode }): ReactNode {
  return render();
}
