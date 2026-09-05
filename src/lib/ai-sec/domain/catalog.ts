/**
 * Display catalogs for AI Security detection codes.
 * Source: developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/
 *   cf.llm.prompt.unsafe_topic_categories/ and cf.llm.prompt.pii_categories/
 */

export interface CategoryInfo {
	code: string;
	name: string;
	description: string;
	/** Rough triage weight used only for sorting "most concerning first". */
	severity: 'critical' | 'high' | 'medium' | 'low';
}

export const UNSAFE_TOPICS: Record<string, CategoryInfo> = {
	S1: { code: 'S1', name: 'Violent crimes', description: 'Violent crimes against people or animals.', severity: 'critical' },
	S2: {
		code: 'S2',
		name: 'Non-violent crimes',
		description: 'Non-violent offenses such as fraud, theft, drug creation, or hacking.',
		severity: 'high',
	},
	S3: {
		code: 'S3',
		name: 'Sex-related crimes',
		description: 'Sex-related crimes, including trafficking, assault, and harassment.',
		severity: 'critical',
	},
	S4: { code: 'S4', name: 'Child sexual exploitation', description: 'Sexual exploitation of children.', severity: 'critical' },
	S5: {
		code: 'S5',
		name: 'Defamation',
		description: "False statements that are likely to damage a living person's reputation.",
		severity: 'medium',
	},
	S6: {
		code: 'S6',
		name: 'Specialized advice',
		description: 'Specialized financial, medical, or legal advice, or misrepresent dangerous things as safe.',
		severity: 'medium',
	},
	S7: {
		code: 'S7',
		name: 'Privacy',
		description: 'Sensitive, nonpublic personal information that could endanger an individual.',
		severity: 'high',
	},
	S8: { code: 'S8', name: 'Intellectual property', description: "Violate a third party's intellectual property rights.", severity: 'low' },
	S9: {
		code: 'S9',
		name: 'Indiscriminate weapons',
		description: 'Creation of indiscriminate weapons like chemical, biological, or nuclear arms.',
		severity: 'critical',
	},
	S10: {
		code: 'S10',
		name: 'Hate',
		description: 'Demean or dehumanize people based on their race, religion, sexual orientation, or other personal characteristics.',
		severity: 'high',
	},
	S11: {
		code: 'S11',
		name: 'Suicide and self-harm',
		description: 'Encourage or endorse suicide, self-injury, or disordered eating.',
		severity: 'critical',
	},
	S12: { code: 'S12', name: 'Sexual content', description: 'Erotic content.', severity: 'medium' },
	S13: {
		code: 'S13',
		name: 'Elections',
		description: 'False information about the time, place, or manner of voting in elections.',
		severity: 'high',
	},
	S14: { code: 'S14', name: 'Code interpreter abuse', description: 'Misuse of code execution capabilities.', severity: 'high' },
};

export const PII_CATEGORIES: Record<string, { name: string; severity: CategoryInfo['severity'] }> = {
	CREDIT_CARD: { name: 'Credit card number', severity: 'critical' },
	CRYPTO: { name: 'Crypto wallet address', severity: 'high' },
	DATE_TIME: { name: 'Date / time', severity: 'low' },
	EMAIL_ADDRESS: { name: 'Email address', severity: 'medium' },
	IBAN_CODE: { name: 'IBAN', severity: 'critical' },
	IP_ADDRESS: { name: 'IP address', severity: 'low' },
	NRP: { name: 'Nationality / religion / politics', severity: 'medium' },
	LOCATION: { name: 'Location', severity: 'low' },
	// Returned by the API but absent from the published category list.
	ORGANIZATION: { name: 'Organization name', severity: 'low' },
	PERSON: { name: 'Person name', severity: 'medium' },
	PHONE_NUMBER: { name: 'Phone number', severity: 'medium' },
	MEDICAL_LICENSE: { name: 'Medical license', severity: 'high' },
	URL: { name: 'URL', severity: 'low' },
	US_BANK_NUMBER: { name: 'US bank account', severity: 'critical' },
	US_DRIVER_LICENSE: { name: 'US driver license', severity: 'high' },
	US_ITIN: { name: 'US ITIN', severity: 'critical' },
	US_PASSPORT: { name: 'US passport', severity: 'critical' },
	US_SSN: { name: 'US SSN', severity: 'critical' },
	UK_NHS: { name: 'UK NHS number', severity: 'critical' },
	UK_NINO: { name: 'UK National Insurance number', severity: 'critical' },
	ES_NIF: { name: 'Spanish NIF', severity: 'high' },
	ES_NIE: { name: 'Spanish NIE', severity: 'high' },
	IT_FISCAL_CODE: { name: 'Italian fiscal code', severity: 'high' },
	IT_DRIVER_LICENSE: { name: 'Italian driver license', severity: 'high' },
	IT_VAT_CODE: { name: 'Italian VAT code', severity: 'medium' },
	IT_PASSPORT: { name: 'Italian passport', severity: 'critical' },
	IT_IDENTITY_CARD: { name: 'Italian identity card', severity: 'critical' },
	PL_PESEL: { name: 'Polish PESEL', severity: 'critical' },
	SG_NRIC_FIN: { name: 'Singapore NRIC / FIN', severity: 'critical' },
	SG_UEN: { name: 'Singapore UEN', severity: 'medium' },
	AU_ABN: { name: 'Australian Business Number', severity: 'medium' },
	AU_ACN: { name: 'Australian Company Number', severity: 'medium' },
	AU_TFN: { name: 'Australian tax file number', severity: 'critical' },
	AU_MEDICARE: { name: 'Australian Medicare number', severity: 'critical' },
	IN_PAN: { name: 'Indian PAN', severity: 'high' },
	IN_AADHAAR: { name: 'Indian Aadhaar', severity: 'critical' },
	IN_VEHICLE_REGISTRATION: { name: 'Indian vehicle registration', severity: 'medium' },
	IN_VOTER: { name: 'Indian voter ID', severity: 'high' },
	IN_PASSPORT: { name: 'Indian passport', severity: 'critical' },
	FI_PERSONAL_IDENTITY_CODE: { name: 'Finnish personal identity code', severity: 'critical' },
};

export function unsafeTopicLabel(code: string): string {
	return UNSAFE_TOPICS[code]?.name ?? code;
}

export function piiLabel(code: string): string {
	return PII_CATEGORIES[code]?.name ?? code;
}

export function categorySeverity(kind: 'pii' | 'topic', code: string): CategoryInfo['severity'] {
	return kind === 'pii' ? (PII_CATEGORIES[code]?.severity ?? 'medium') : (UNSAFE_TOPICS[code]?.severity ?? 'medium');
}

/**
 * Injection score semantics (cf.llm.prompt.injection_score):
 *   1-99, where a LOW score means a HIGH probability of prompt injection.
 *   100 is the sentinel for "Cloudflare did not score this request" — it is NOT a safe score.
 */
export const INJECTION_ATTACK_THRESHOLD = 20;
export const INJECTION_UNSCORED = 100;

export const INJECTION_BUCKETS = [
	{ label: '1–19 (likely attack)', min: 1, max: 19, tone: 'critical' as const },
	{ label: '20–39', min: 20, max: 39, tone: 'high' as const },
	{ label: '40–59', min: 40, max: 59, tone: 'medium' as const },
	{ label: '60–79', min: 60, max: 79, tone: 'low' as const },
	{ label: '80–99 (likely benign)', min: 80, max: 99, tone: 'low' as const },
	{ label: 'Not scored', min: 100, max: 100, tone: 'unknown' as const },
];

export function injectionBucket(score: number): (typeof INJECTION_BUCKETS)[number] {
	return INJECTION_BUCKETS.find((b) => score >= b.min && score <= b.max) ?? INJECTION_BUCKETS[INJECTION_BUCKETS.length - 1];
}

/** The managed endpoint label that marks LLM traffic for AI Security for Apps. */
export const LLM_LABEL = 'cf-llm';
