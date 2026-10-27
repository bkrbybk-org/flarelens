import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useRoute } from "../../web/src/hooks/useRoute";

/** Why Blocked? was merged into Request Trace; its old links must still land, Ray ID and all. */
describe("useRoute aliases", () => {
	it("sends #/why?ray=… to #/request with the query kept", () => {
		history.replaceState(null, "", "#/why?ray=a511938d1a0dd949");
		const { result } = renderHook(() => useRoute());
		expect(result.current[0]).toBe("request");
		expect(location.hash).toBe("#/request?ray=a511938d1a0dd949");
	});
});
