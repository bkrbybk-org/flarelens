// Workers' `ExecutionContext` carries more than `waitUntil`/`passThroughOnException` — it also
// requires `exports` (Cloudflare.Exports) and `tracing` (Tracing), neither of which any test
// here reads or the fetch handler under test touches. Building real instances of those types
// would mean faking internal runtime machinery no test cares about, so the fixture is asserted
// through `unknown` with a comment rather than typed structurally end to end.
export function ctx(): ExecutionContext {
	return {
		waitUntil: (promise: Promise<unknown>) => void promise,
		passThroughOnException: () => {},
		props: {},
	} as unknown as ExecutionContext;
}
