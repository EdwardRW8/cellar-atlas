import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/Button";

interface Props {
  children: ReactNode;
  /** Shown to the user, e.g. "Rack" or "Atlas". */
  area: string;
  onReset?: () => void;
}
interface State {
  error: Error | null;
}

/**
 * Error isolation.
 *
 * V2 had none: a throw inside the rack renderer blanked the whole app,
 * including the collection list which had nothing to do with it. Each route
 * and each heavy visualisation is wrapped separately so a failure is
 * contained to the thing that failed.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Phase 11 will forward this to error monitoring.
    console.error(`[${this.props.area}]`, error, info.componentStack);
  }

  private reset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div
        role="alert"
        style={{
          margin: "1rem",
          padding: "1.5rem",
          background: "var(--surface-raised)",
          border: "1px solid rgba(255,138,122,0.3)",
          borderRadius: 14,
        }}
      >
        <h2
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "1.25rem",
            fontStyle: "italic",
            color: "var(--status-past)",
            marginBottom: "0.5rem",
          }}
        >
          {this.props.area} could not be displayed
        </h2>
        <p
          style={{
            color: "var(--text-secondary)",
            fontSize: "0.875rem",
            marginBottom: "1rem",
          }}
        >
          The rest of the app is unaffected and your data is safe.
        </p>
        <p
          style={{
            color: "var(--text-tertiary)",
            fontSize: "0.75rem",
            fontFamily: "ui-monospace, monospace",
            marginBottom: "1.25rem",
            wordBreak: "break-word",
          }}
        >
          {this.state.error.message}
        </p>
        <Button variant="secondary" onClick={this.reset}>
          Try again
        </Button>
      </div>
    );
  }
}
