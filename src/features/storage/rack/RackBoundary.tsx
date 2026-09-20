import { Component, type ReactNode } from "react";

/**
 * Inner boundary for the rack.
 *
 * In V2 a throw inside `WineRack` blanked the entire application, including
 * the collection list that had nothing to do with the rack
 * (`docs/architecture.md`). The route boundary would catch it, but the whole
 * screen would still go. This keeps the failure inside the visualisation and
 * falls back to the list, which always works.
 */
export class RackBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.error("Rack renderer failed:", error);
  }

  render() {
    if (this.state.failed) {
      return (
        <div>
          <p
            role="alert"
            style={{
              padding: "0.75rem 1rem",
              borderRadius: 10,
              marginBottom: "0.75rem",
              background: "rgba(245,181,68,0.08)",
              border: "1px solid rgba(245,181,68,0.25)",
              color: "var(--status-approaching)",
              fontSize: "0.8125rem",
              lineHeight: 1.6,
            }}
          >
            The visual rack could not be drawn. Your bottles are listed below instead —
            nothing is lost.
          </p>
          {this.props.fallback}
        </div>
      );
    }
    return this.props.children;
  }
}
