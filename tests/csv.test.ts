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

	it("neutralises cells a spreadsheet would run as a formula", () => {
		const cols = [{ header: "v", value: (r: { v: unknown }) => r.v }];
		const out = toCsv([{ v: "=HYPERLINK(\"http://x\")" }, { v: "+1" }, { v: "-cmd" }, { v: "@SUM(A1)" }, { v: "\tx" }], cols);
		expect(out.split("\r\n").slice(1)).toEqual(['"\'=HYPERLINK(""http://x"")"', "'+1", "'-cmd", "'@SUM(A1)", "'\tx"]);
	});

	it("leaves numbers and ordinary text alone", () => {
		const cols = [{ header: "v", value: (r: { v: unknown }) => r.v }];
		expect(toCsv([{ v: -5 }, { v: "a-b" }, { v: "/path" }], cols).split("\r\n").slice(1)).toEqual(["-5", "a-b", "/path"]);
	});
});
