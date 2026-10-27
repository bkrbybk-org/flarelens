import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { addExtraAccounts, clearExtraAccounts, listExtraAccounts, removeExtraAccount } from "../../web/src/lib/extraAccounts";
import { useSession } from "../../web/src/hooks/useSession";
import { AddAccountDialog } from "../../web/src/components/shell/AddAccountDialog";
import type * as ApiClientModule from "../../web/src/api/client";

vi.mock("../../web/src/api/client", async (importOriginal) => {
	const actual = await importOriginal<typeof ApiClientModule>();
	return { ...actual, fetchAccounts: vi.fn() };
});
import { ApiError, fetchAccounts } from "../../web/src/api/client";

const A = "a".repeat(32);
const B = "b".repeat(32);

beforeEach(() => {
	sessionStorage.clear();
	localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe("extraAccounts storage", () => {
	it("adds, replaces by id, removes and clears — in session storage only", () => {
		addExtraAccounts([{ id: A, name: "Customer A", token: "t1" }]);
		addExtraAccounts([{ id: A, name: "Customer A", token: "t2" }, { id: B, name: "Customer B", token: "t2" }]);
		expect(listExtraAccounts().map((a) => [a.id, a.token])).toEqual([[A, "t2"], [B, "t2"]]);
		expect(removeExtraAccount(A).map((a) => a.id)).toEqual([B]);
		clearExtraAccounts();
		expect(listExtraAccounts()).toEqual([]);
		expect(localStorage.length).toBe(0);
	});

	it("drops malformed entries rather than trusting them", () => {
		sessionStorage.setItem("flarelens_extra_accounts", JSON.stringify([{ id: "not-an-id", name: "x", token: "t" }, { id: A, name: "ok", token: "" }, { id: B, name: "ok", token: "t" }]));
		expect(listExtraAccounts().map((a) => a.id)).toEqual([B]);
	});
});

describe("useSession — switching to an added account", () => {
	it("does not replace the stored sign-in, so a reload returns to it", () => {
		const { result } = renderHook(() => useSession());
		act(() => result.current.connect({ token: "primary", accountId: A, accountName: "Primary", mode: "byot" }));
		act(() => result.current.connect({ token: "added", accountId: B, accountName: "Added", mode: "byot" }, { persist: false }));
		expect(result.current.session?.token).toBe("added");
		expect(sessionStorage.getItem("cf_api_token")).toBe("primary");
		expect(sessionStorage.getItem("cf_account_id")).toBe(A);
	});

	it("clears a stored token when the deployment's own credential takes over", () => {
		const { result } = renderHook(() => useSession());
		act(() => result.current.connect({ token: "primary", accountId: A, accountName: "Primary", mode: "byot" }));
		act(() => result.current.connect({ token: "", accountId: A, accountName: "Primary", mode: "server" }));
		expect(sessionStorage.getItem("cf_api_token")).toBeNull();
	});
});

describe("AddAccountDialog", () => {
	it("looks up the token's accounts and adds the chosen ones with that token", async () => {
		vi.mocked(fetchAccounts).mockResolvedValue([{ id: A, name: "Already here" }, { id: B, name: "Customer B" }]);
		const onAdd = vi.fn();
		const user = userEvent.setup();
		render(<AddAccountDialog knownIds={new Set([A])} onCancel={vi.fn()} onAdd={onAdd} />);
		await user.type(screen.getByLabelText("API token"), "  tok-b  ");
		await user.click(screen.getByRole("button", { name: "Find accounts" }));
		expect(fetchAccounts).toHaveBeenCalledWith("tok-b");
		// New accounts are preselected; one already listed is not.
		expect(screen.getByRole("checkbox", { name: /Customer B/ })).toBeChecked();
		expect(screen.getByRole("checkbox", { name: /Already here/ })).not.toBeChecked();
		await user.click(screen.getByRole("button", { name: "Add 1 account" }));
		expect(onAdd).toHaveBeenCalledWith([{ id: B, name: "Customer B", token: "tok-b" }]);
	});

	it("says why when Cloudflare refuses the token, and adds nothing", async () => {
		vi.mocked(fetchAccounts).mockRejectedValue(new ApiError("Invalid API Token", 403));
		const user = userEvent.setup();
		render(<AddAccountDialog knownIds={new Set()} onCancel={vi.fn()} onAdd={vi.fn()} />);
		await user.type(screen.getByLabelText("API token"), "bad");
		await user.click(screen.getByRole("button", { name: "Find accounts" }));
		expect(screen.getByRole("alert")).toHaveTextContent("Cloudflare refused this token: Invalid API Token");
		expect(screen.getByRole("button", { name: /^Add/ })).toBeDisabled();
	});
});
