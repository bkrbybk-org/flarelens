import { AeadId, CipherSuite, KdfId, KemId } from "hpke-js";

/**
 * Decrypt a Cloudflare "matched data" payload — the encrypted prompt that AI Security records
 * when payload logging is on.
 *
 * Everything here runs in the browser with a private key the operator supplies. The key is never
 * sent to the Worker and never stored; the Worker only ever handles ciphertext. That is what
 * makes it acceptable to show prompt text at all: the ability to read it is gated on holding the
 * zone's private key, not on being able to reach the dashboard.
 *
 * Blob layout, verified against live payloads from this account:
 *
 *   byte  0        format version, must be 3
 *   bytes 1..33    32-byte X25519 encapsulated key (HPKE `enc`)
 *   bytes 33..41   plaintext length, uint64 little-endian
 *   bytes 41..     AES-256-GCM ciphertext, i.e. plaintext length + 16-byte tag
 *
 * HPKE is base mode over DHKEM(X25519, HKDF-SHA256) with HKDF-SHA256 and AES-256-GCM, with
 * empty `info` and empty AAD.
 */

const SUPPORTED_VERSION = 3;
const ENC_LENGTH = 32;
const LENGTH_FIELD_OFFSET = 1 + ENC_LENGTH;
const CIPHERTEXT_OFFSET = LENGTH_FIELD_OFFSET + 8;
const GCM_TAG_LENGTH = 16;

export class MatchedDataError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MatchedDataError";
	}
}

function fromBase64(value: string, what: string): Uint8Array {
	const cleaned = value.trim().replace(/\s+/g, "");
	if (!cleaned) throw new MatchedDataError(`${what} is empty.`);
	let binary: string;
	try {
		binary = atob(cleaned);
	} catch {
		throw new MatchedDataError(`${what} is not valid base64.`);
	}
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/**
 * The private key as the operator has it in hand.
 *
 * Cloudflare shows the payload-logging key pair in the dashboard, and the value that gets pasted
 * here is not guaranteed to be base64: a 64-character hex string is exactly the same 32-byte
 * X25519 key written the other way, and every byte of it is also a legal base64 character, so a
 * hex key decodes as base64 without error and comes out 48 bytes long. That surfaces as "must be
 * 32 bytes" against a key that is perfectly correct, so hex is detected first and decoded as hex.
 */
function fromKeyText(value: string): Uint8Array {
	const cleaned = value.trim().replace(/\s+/g, "").replace(/^0x/i, "");
	if (!cleaned) throw new MatchedDataError("Private key is empty.");
	if (/^[0-9a-fA-F]+$/.test(cleaned) && cleaned.length === ENC_LENGTH * 2) {
		const bytes = new Uint8Array(ENC_LENGTH);
		for (let i = 0; i < ENC_LENGTH; i++) bytes[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
		return bytes;
	}
	return fromBase64(cleaned, "Private key");
}

export interface ParsedBlob {
	enc: Uint8Array;
	ciphertext: Uint8Array;
	/** Declared plaintext length, used to sanity-check the blob before any crypto runs. */
	plaintextLength: number;
}

export function parseMatchedDataBlob(blobBase64: string): ParsedBlob {
	const bytes = fromBase64(blobBase64, "Encrypted payload");
	if (bytes.length <= CIPHERTEXT_OFFSET + GCM_TAG_LENGTH) {
		throw new MatchedDataError("Encrypted payload is too short to be a matched-data blob.");
	}
	if (bytes[0] !== SUPPORTED_VERSION) {
		throw new MatchedDataError(`Unsupported matched-data version ${bytes[0]} (expected ${SUPPORTED_VERSION}).`);
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset + LENGTH_FIELD_OFFSET, 8);
	const low = view.getUint32(0, true);
	const high = view.getUint32(4, true);
	// A non-zero high word would mean a payload larger than 4GB; that is a corrupt blob, not a
	// prompt, and reading it as a length would allocate wildly.
	if (high !== 0) {
		throw new MatchedDataError("Encrypted payload declares an implausible length.");
	}

	const ciphertext = bytes.slice(CIPHERTEXT_OFFSET);
	if (ciphertext.length !== low + GCM_TAG_LENGTH) {
		throw new MatchedDataError("Encrypted payload length does not match its header.");
	}

	return { enc: bytes.slice(1, LENGTH_FIELD_OFFSET), ciphertext, plaintextLength: low };
}

function suite(): CipherSuite {
	return new CipherSuite({ kem: KemId.DhkemX25519HkdfSha256, kdf: KdfId.HkdfSha256, aead: AeadId.Aes256Gcm });
}

/**
 * Decrypt one payload. Returns the plaintext prompt.
 *
 * A wrong key fails inside AES-GCM authentication rather than producing garbage, so the error
 * distinguishes "wrong key" from "malformed blob" — the operator needs to know which. The key
 * itself is accepted as base64 or hex; see fromKeyText.
 */
export async function decryptMatchedData(privateKey: string, blobBase64: string): Promise<string> {
	const { enc, ciphertext } = parseMatchedDataBlob(blobBase64);
	const rawKey = fromKeyText(privateKey);
	if (rawKey.length !== ENC_LENGTH) {
		throw new MatchedDataError(`Private key must be ${ENC_LENGTH} bytes; got ${rawKey.length}. Paste it as base64 or hex.`);
	}

	const cipherSuite = suite();
	let recipientKey;
	try {
		recipientKey = await cipherSuite.kem.importKey("raw", rawKey.slice().buffer, false);
	} catch {
		throw new MatchedDataError("Private key is not a valid X25519 key.");
	}

	let plaintext: ArrayBuffer;
	try {
		const recipient = await cipherSuite.createRecipientContext({ recipientKey, enc: enc.slice().buffer });
		plaintext = await recipient.open(ciphertext.slice().buffer);
	} catch {
		throw new MatchedDataError("Could not decrypt with this key — check it belongs to the zone that logged this payload.");
	}
	return new TextDecoder().decode(plaintext);
}
