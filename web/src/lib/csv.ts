// RFC 4180 CSV encoding: fields containing a comma, quote, or newline are
// wrapped in double quotes, and inner quotes are escaped by doubling.
export interface CsvColumn<T> {
	header: string;
	value: (row: T) => unknown;
}

function csvField(value: unknown): string {
	const s = value === null || value === undefined ? "" : String(value);
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
	const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}
