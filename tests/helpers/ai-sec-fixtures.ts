import type { RawEvent } from "../../web/src/lib/ai-sec/types";

/**
 * A RawEvent with every field explicitly null/empty, so each test states exactly the fields it
 * depends on. Defaulting to "nothing detected" keeps a fixture change from silently satisfying
 * a detection predicate somewhere else.
 */
export function event(overrides: Partial<RawEvent> = {}): RawEvent {
	return {
		zoneId: "44444444444444444444444444444444",
		zoneName: "example.com",
		datetime: "2026-09-04T10:07:33Z",
		rayName: null,
		clientIP: null,
		country: null,
		asnDescription: null,
		ja4: null,
		host: null,
		path: null,
		method: null,
		status: null,
		securityAction: null,
		injectionScore: null,
		piiCategories: [],
		unsafeTopicCategories: [],
		customTopics: [],
		customTopicScoreMin: null,
		tokenCount: null,
		sampleInterval: 1,
		payload: null,
		operationId: null,
		...overrides,
	};
}
