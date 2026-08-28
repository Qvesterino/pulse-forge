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
        return (
          <div className="panel-error" role="alert">
            <span className="panel-error-title">{this.props.panel} crashed</span>
            <span className="panel-error-detail">{this.state.error?.message}</span>
            <button type="button" className="btn btn-small" onClick={this.handleRetry}>
              Retry
            </button>
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
