import { Component, type ReactNode } from "react";
import { Icon } from "../Icon";

interface Props { children: ReactNode; fallback?: ReactNode; }
interface State { hasError: boolean; error?: Error; }

/** Keeps a chart crash from taking the whole page down; renders an inline notice. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div className="flex items-center gap-2 p-4 rounded-lg border border-danger/30 bg-dangerSoft/40 text-sm text-danger">
          <Icon name="warning" size={16} />
          <span>{this.state.error?.message || "Something went wrong rendering this panel."}</span>
        </div>
      );
    }
    return this.props.children;
  }
}
