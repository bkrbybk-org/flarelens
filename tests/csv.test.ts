import { describe, expect, it } from "vitest";
import { toCsv } from "../web/src/lib/csv";

interface Row {
	name: string;
	note: string;
	count: number;
}

describe("toCsv", () => {
	it("renders a header row and simple values", () => {
		const rows: Row[] = [{ name: "a", note: "plain", count: 1 }];
		const csv = toCsv(rows, [
			{ header: "Name", value: (r) => r.name },
			{ header: "Note", value: (r) => r.note },
			{ header: "Count", value: (r) => r.count },
		]);
		expect(csv).toBe("Name,Note,Count\r\na,plain,1");
	});

	it("quotes fields containing commas", () => {
		const csv = toCsv([{ v: "a,b" }], [{ header: "V", value: (r) => r.v }]);
		expect(csv).toBe('V\r\n"a,b"');
	});

	it("quotes fields containing quotes and doubles them", () => {
		const csv = toCsv([{ v: 'say "hi"' }], [{ header: "V", value: (r) => r.v }]);
		expect(csv).toBe('V\r\n"say ""hi"""');
	});

	it("quotes fields containing newlines", () => {
		const csv = toCsv([{ v: "line1\nline2" }], [{ header: "V", value: (r) => r.v }]);
		expect(csv).toBe('V\r\n"line1\nline2"');
	});

	it("renders null/undefined as empty string", () => {
		const csv = toCsv([{ v: null }, { v: undefined }], [{ header: "V", value: (r: { v: unknown }) => r.v }]);
		expect(csv).toBe("V\r\n\r\n");
	});

	it("handles an empty row set (header only)", () => {
		const csv = toCsv([], [{ header: "V", value: () => "" }]);
		expect(csv).toBe("V");
	});
});
