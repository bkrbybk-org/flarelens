import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Unmount whatever the previous test rendered so assertions never see a stale tree,
// and so React doesn't warn about updating an unmounted component from a later test.
afterEach(() => {
	cleanup();
});
