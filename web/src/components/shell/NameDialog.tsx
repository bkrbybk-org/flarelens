import { useEffect, useRef, useState, type FormEvent } from "react";
import { BTN_PRIMARY, BTN_SECONDARY, INPUT } from "../../lib/ui";
import { useFocusTrap } from "../../hooks/useFocusTrap";

interface NameDialogProps {
	title: string;
	initialValue: string;
	confirmLabel: string;
	onCancel: () => void;
	onConfirm: (name: string) => void;
}

/**
 * A small accessible modal for naming something — saving a view, renaming one. One definition
 * rather than a `window.prompt()` here and a custom form there.
 */
export function NameDialog({ title, initialValue, confirmLabel, onCancel, onConfirm }: NameDialogProps) {
	const [value, setValue] = useState(initialValue);
	const containerRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	useFocusTrap(containerRef, true, onCancel);

	useEffect(() => {
		inputRef.current?.focus();
		inputRef.current?.select();
	}, []);

	function submit(e: FormEvent) {
		e.preventDefault();
		if (value.trim()) onConfirm(value);
	}

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center p-4">
			<button type="button" aria-label="Close dialog" className="absolute inset-0 bg-black/50" onClick={onCancel} />
			<div
				ref={containerRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="name-dialog-title"
				className="relative w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-4 shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
			>
				<h2 id="name-dialog-title" className="mb-3 text-sm font-semibold">{title}</h2>
				<form onSubmit={submit}>
					<label htmlFor="name-dialog-input" className="sr-only">Name</label>
					<input
						id="name-dialog-input"
						ref={inputRef}
						value={value}
						onChange={(e) => setValue(e.target.value)}
						className={`w-full ${INPUT}`}
					/>
					<div className="mt-4 flex justify-end gap-2">
						<button type="button" onClick={onCancel} className={BTN_SECONDARY}>Cancel</button>
						<button type="submit" disabled={!value.trim()} className={BTN_PRIMARY}>{confirmLabel}</button>
					</div>
				</form>
			</div>
		</div>
	);
}
