import React from 'react';

interface IsolatedFeatureBoundaryProps {
  featureName: string;
  children: React.ReactNode;
}

interface IsolatedFeatureBoundaryState {
  hasError: boolean;
}

export class IsolatedFeatureBoundary extends React.Component<IsolatedFeatureBoundaryProps, IsolatedFeatureBoundaryState> {
  constructor(props: IsolatedFeatureBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): IsolatedFeatureBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.error(`[Isolation Boundary] ${this.props.featureName} crashed without impacting WhatsApp runtime`, error);
  }

  handleRetry = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-6 m-6 rounded-xl border border-amber-200 bg-amber-50 text-amber-800">
          <h3 className="text-lg font-bold mb-2">{this.props.featureName} is temporarily isolated</h3>
          <p className="text-sm mb-4">
            This section failed to load, but the WhatsApp chatbot flow and live server connection are still protected and running.
          </p>
          <button
            onClick={this.handleRetry}
            className="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-semibold hover:bg-amber-700"
          >
            Retry section
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
