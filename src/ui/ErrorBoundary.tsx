import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  onCrashSave?: () => void;
  /** Inline panel mode — renders a compact retry UI instead of the full crash screen. */
  panel?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * A lazy() import rejection is cached by React: retrying the boundary just
 * replays the same rejected promise (usually a chunk 404 after a deploy,
 * while this tab still runs the old index.html). Those failures need a
 * reload, not a retry.
 */
function isChunkLoadError(error: Error | null): boolean {
  const message = error?.message ?? "";
  return (
    message.includes("Failed to fetch dynamically imported module") ||
    message.includes("Importing a module script failed") ||
    message.includes("error loading dynamically imported module") ||
    (message.includes("Loading chunk") && message.includes("failed"))
  );
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ErrorBoundary${this.props.panel ? `:${this.props.panel}` : ""}]`, error, info.componentStack);
    try {
      this.props.onCrashSave?.();
    } catch {
      // best-effort — don't throw during error handling
    }
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      if (this.props.panel) {
        const staleChunk = isChunkLoadError(this.state.error);
        return (
          <div className="panel-error" role="alert">
            <span className="panel-error-title">{this.props.panel} crashed</span>
            <span className="panel-error-detail">
              {staleChunk
                ? "The app was updated since this tab loaded — reload to pick up the new version."
                : this.state.error?.message}
            </span>
            <button type="button" className="btn btn-small" onClick={this.handleRetry}>
              Retry
            </button>
            {staleChunk && (
              <button type="button" className="btn btn-small" onClick={this.handleReload}>
                Reload app
              </button>
            )}
          </div>
        );
      }
      return (
        <div className="crash-screen" role="alert">
          <h1>PulseForge crashed</h1>
          <p>Your work has been saved. Reload to continue.</p>
          <p className="crash-detail">{this.state.error?.message}</p>
          <button type="button" className="btn" onClick={this.handleReload}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
