/**
 * Last-resort boundary for the editor and options pages: a render error shows a calm message with
 * a reload, in the same editorial style as the capture errors, instead of a blank tab.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  failed: boolean;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('Page Snap: render error', error, info.componentStack);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="ps-center" data-testid="state-crashed">
        <section className="ps-error" role="alert" aria-labelledby="ps-crash-title">
          <h1 id="ps-crash-title">Something went wrong on this page</h1>
          <p>Your captures and marks are saved on this device. Reloading usually fixes it.</p>
          <button
            type="button"
            className="ps-error-action"
            onClick={() => window.location.reload()}
          >
            Reload this tab
          </button>
        </section>
      </div>
    );
  }
}
