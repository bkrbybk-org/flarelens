import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
	children: ReactNode;
}

interface ErrorBoundaryState {
	error: Error | null;
	componentStack: string;
}

// Formats the details we hand to the "Copy details" button. Extracted as a
// pure function so it can be unit-tested without touching the DOM — the
// class component itself needs jsdom, which this project's vitest config
// doesn't provide.
export function formatErrorDetails(error: Error | null, componentStack: string): string {
	const message = error ? `${error.name}: ${error.message}` : "Unknown error";
	const stack = error?.stack ? `\n\n${error.stack}` : "";
	const componentTrace = componentStack ? `\n\nComponent stack:${componentStack}` : "";
	return `${message}${stack}${componentTrace}`;
}

// Class component is required here — React has no hook equivalent for
// getDerivedStateFromError / componentDidCatch. This sits at the root (see
// main.tsx) so one bad render in any feature page doesn't blank the whole app.
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
	state: ErrorBoundaryState = { error: null, componentStack: "" };

	static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		// Log locally only. This app handles customer Cloudflare data, so the
		// stack trace could contain sensitive values — never ship it anywhere.
		console.error(error, info.componentStack);
		this.setState({ componentStack: info.componentStack ?? "" });
	}

	handleReload = (): void => {
		window.location.reload();
	};

	handleCopy = (): void => {
		const details = formatErrorDetails(this.state.error, this.state.componentStack);
		void navigator.clipboard?.writeText(details);
	};

	render(): ReactNode {
		const { error, componentStack } = this.state;
		if (!error) {
			return this.props.children;
		}

		return (
			<div className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 dark:bg-zinc-950">
				<div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
					<h1 className="mb-1.5 text-base font-semibold text-zinc-900 dark:text-zinc-100">Something went wrong</h1>
					<p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
						A rendering error crashed this view. Your session is still connected — reloading the page usually fixes it.
					</p>

					<div role="alert" className="mb-4 rounded-lg border border-red-300/50 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:border-red-500/30 dark:text-red-400">
						{error.message}
					</div>

					<div className="flex gap-2">
						<button
							type="button"
							onClick={this.handleReload}
							className="rounded-lg bg-cf px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-cf-hover disabled:opacity-60"
						>
							Reload
						</button>
						<button
							type="button"
							onClick={this.handleCopy}
							className="rounded-lg border border-zinc-300 px-4 py-2.5 text-sm font-medium transition hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
						>
							Copy details
						</button>
					</div>

					{componentStack && (
						<pre className="mt-4 max-h-40 overflow-auto rounded-lg border border-zinc-200 bg-zinc-50 p-2 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
							{componentStack.trim()}
						</pre>
					)}
				</div>
			</div>
		);
	}
}
