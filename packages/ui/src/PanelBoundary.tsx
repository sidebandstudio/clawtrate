import { Component, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  /** The fallback's own class beside `empty`: where it must sit as its panel does (the Work drawer). */
  className?: string;
  /** Told when the panel fails and when it draws again, for what the shell does only while it shows. */
  onFailed?: (failed: boolean) => void;
};

/** One panel that throws shows this in its place; the rail and the other panels stay. */
export class PanelBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(): void {
    this.props.onFailed?.(true);
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
      >
        <div>
          <h1 tabIndex={-1}>Couldn't show this part</h1>
          <p>Something here stopped working. The rest of Clawtrate still works.</p>
          <div className="empty-actions">
            <button
              type="button"
              className="button"
              onClick={() => {
                this.setState({ failed: false });
                this.props.onFailed?.(false);
              }}
            >
              Try again
            </button>
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
