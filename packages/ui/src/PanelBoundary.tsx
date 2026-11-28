import { Component, type ReactNode } from "react";

/** One panel that throws shows this in its place; the rail and the other panels stay. */
export class PanelBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="empty" role="alert" data-testid="panel-failed">
        <div>
          <h1 tabIndex={-1}>Couldn't show this part</h1>
          <p>Something here stopped working. The rest of Clawtrate still works.</p>
          <div className="empty-actions">
            <button
              type="button"
              className="button"
              onClick={() => this.setState({ failed: false })}
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }
}
