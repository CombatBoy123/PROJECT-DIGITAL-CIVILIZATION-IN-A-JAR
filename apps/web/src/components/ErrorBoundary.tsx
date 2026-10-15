import { Component, type ErrorInfo, type ReactNode } from 'react';

/*
 * Last line of defence for rendering errors: shows what failed and offers a reload
 * instead of a blank page.
 */

interface Props {
  children: ReactNode;
  /** Short name of the area, shown in the message ("Dashboard", "Inspector"…). */
  area?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Render error', error, info.componentStack);
  }

  private readonly reset = () => this.setState({ error: null });

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="alert alert-error error-boundary" role="alert">
        <strong>
          {this.props.area ? `${this.props.area} failed to render` : 'Something broke'}
        </strong>
        <p className="mono">{error.message}</p>
        <div className="row gap-s">
          <button type="button" className="btn btn-sm" onClick={this.reset}>
            Try again
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => location.reload()}>
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
