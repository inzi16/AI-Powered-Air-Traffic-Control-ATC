import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';
import { Clipboard, RefreshCw, RotateCcw, ShieldAlert } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string;
  occurredAt: string;
  recoveryAttempt: number;
  copied: boolean;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = {
    error: null,
    componentStack: '',
    occurredAt: '',
    recoveryAttempt: 0,
    copied: false,
  };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error, occurredAt: new Date().toISOString(), copied: false };
  }

  componentDidCatch(_error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack || '' });
  }

  private diagnostics = (): string => {
    const { error, componentStack, occurredAt } = this.state;
    return [
      'Smart ATC frontend failure',
      `Time: ${occurredAt || new Date().toISOString()}`,
      `Location: ${window.location.href}`,
      `Browser: ${navigator.userAgent}`,
      `Online: ${navigator.onLine}`,
      `Error: ${error?.name || 'Error'}: ${error?.message || 'Unknown render failure'}`,
      componentStack ? `Component trace:${componentStack}` : '',
    ].filter(Boolean).join('\n');
  };

  private retry = (): void => {
    this.setState((current) => ({
      error: null,
      componentStack: '',
      occurredAt: '',
      copied: false,
      recoveryAttempt: current.recoveryAttempt + 1,
    }));
  };

  private copyDiagnostics = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(this.diagnostics());
      this.setState({ copied: true });
    } catch {
      this.setState({ copied: false });
    }
  };

  render() {
    if (!this.state.error) {
      return <Fragment key={this.state.recoveryAttempt}>{this.props.children}</Fragment>;
    }

    return (
      <main className="fatal-boundary" aria-labelledby="fatal-boundary-title">
        <section className="fatal-boundary__panel" role="alert">
          <span className="fatal-boundary__icon"><ShieldAlert aria-hidden="true" /></span>
          <div>
            <span className="eyebrow">Local interface recovery</span>
            <h1 id="fatal-boundary-title">The cockpit interface encountered an error</h1>
            <p>Live commands are not queued by this screen. Retry the interface, or reload to request a clean application shell.</p>
          </div>
          <div className="fatal-boundary__actions">
            <button className="primary-button" type="button" onClick={this.retry}><RotateCcw aria-hidden="true" />Try again</button>
            <button className="secondary-button" type="button" onClick={() => window.location.reload()}><RefreshCw aria-hidden="true" />Reload cockpit</button>
          </div>
          <details>
            <summary>Recovery diagnostics</summary>
            <pre>{this.diagnostics()}</pre>
            <button className="quiet-button" type="button" onClick={() => void this.copyDiagnostics()}><Clipboard aria-hidden="true" />{this.state.copied ? 'Diagnostics copied' : 'Copy diagnostics'}</button>
          </details>
        </section>
      </main>
    );
  }
}
