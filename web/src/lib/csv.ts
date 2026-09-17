// RFC 4180 CSV encoding: fields containing a comma, quote, or newline are
// wrapped in double quotes, and inner quotes are escaped by doubling.
export interface CsvColumn<T> {
	header: string;
	value: (row: T) => unknown;
}

/**
 * Text a spreadsheet would run as a formula. Exports carry text this app does not control —
 * request paths from WAF events, DNS TXT content, application names — so a cell reading
 * `=HYPERLINK(...)` must arrive as text. Only strings are guarded: a number like -5 is data.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

function csvField(value: unknown): string {
	let s = value === null || value === undefined ? "" : String(value);
	if (typeof value === "string" && FORMULA_START.test(s)) {
		// OWASP's mitigation: a leading apostrophe makes the cell text in Excel, Sheets and Calc.
		s = `'${s}`;
	}
	if (/[",\n\r]/.test(s)) {
		return `"${s.replace(/"/g, '""')}"`;
	}
	return s;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
	const lines = [columns.map((c) => csvField(c.header)).join(",")];
	for (const row of rows) {
		lines.push(columns.map((c) => csvField(c.value(row))).join(","));
	}
	return lines.join("\r\n");
}

// Triggers a client-side download via a Blob + object URL, revoked afterwards.
export function downloadCsv(filename: string, csv: string): void {
	// The byte-order mark is what makes Excel read the file as UTF-8; without it, non-Latin
	// names (Thai application names, for one) open as mojibake.
	const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8;" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}
