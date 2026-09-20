import { Component, type ReactNode } from "react";

/**
 * Inner boundary for Atlas.
 *
 * `docs/architecture.md` requires heavy visualisations to carry a second
 * boundary, because in V2 a throw inside the rack renderer blanked the whole
 * application. Atlas loads an 83 KB geometry asset and projects it — plenty of
 * scope for a failure that should not take the rest of the screen with it.
 */
export class AtlasBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.error("Atlas visualisation failed:", error);
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
            The map could not be drawn. Your collection is listed below instead — nothing is
            lost.
          </p>
          {this.props.fallback}
        </div>
      );
    }
    return this.props.children;
  }
}
