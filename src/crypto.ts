import { b64, utf8 } from "./util.ts";

const subtle = () => globalThis.crypto.subtle;

async function hmacKey(secret: string | Uint8Array, usage: KeyUsage[] = ["sign", "verify"]): Promise<CryptoKey> {
	const raw = typeof secret === "string" ? utf8.encode(secret) : secret;
	return subtle().importKey("raw", new Uint8Array(raw), { name: "HMAC", hash: "SHA-256" }, false, usage);
}

export async function hmacSha256(secret: string | Uint8Array, data: string): Promise<Uint8Array> {
	const key = await hmacKey(secret, ["sign"]);
	return new Uint8Array(await subtle().sign("HMAC", key, utf8.encode(data)));
}

export async function sha256Hex(data: string): Promise<string> {
	const d = new Uint8Array(await subtle().digest("SHA-256", utf8.encode(data)));
	return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export function hex(bytes: Uint8Array): string {
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Signs short link tokens (confirm, unsubscribe, preferences, tracking).
 * Tokens are `<payload>.<sig>` where payload is base64url JSON and sig is a
 * truncated HMAC. They're stateless: nothing is stored per link.
 */
export class Signer {
	#secret: string;
	constructor(secret: string) {
		if (!secret || secret.length < 16) throw new Error("emdash-newsletter: secret must be at least 16 characters");
		this.#secret = secret;
	}

	async sign(purpose: string, data: Record<string, unknown>, ttlMs?: number): Promise<string> {
		const body = { ...data, ...(ttlMs ? { x: Date.now() + ttlMs } : {}) };
		const payload = b64.url(utf8.encode(JSON.stringify(body)));
		const sig = b64.url((await hmacSha256(this.#secret, `${purpose}.${payload}`)).subarray(0, 16));
		return `${payload}.${sig}`;
	}

	async verify<T extends Record<string, unknown>>(purpose: string, token: unknown): Promise<T | null> {
		if (typeof token !== "string" || token.length > 2048) return null;
		const dot = token.lastIndexOf(".");
		if (dot < 1) return null;
		const payload = token.slice(0, dot);
		const sig = token.slice(dot + 1);
		const expected = b64.url((await hmacSha256(this.#secret, `${purpose}.${payload}`)).subarray(0, 16));
		if (!timingSafeEqual(sig, expected)) return null;
		try {
			const data = JSON.parse(new TextDecoder().decode(b64.fromUrl(payload))) as T & { x?: number };
			if (typeof data.x === "number" && data.x < Date.now()) return null;
			return data;
		} catch {
			return null;
		}
	}

	/** Short MAC over a value, for compact tracking tokens (`<value>.<mac>`). */
	async mac(purpose: string, value: string): Promise<string> {
		return b64.url((await hmacSha256(this.#secret, `${purpose}.${value}`)).subarray(0, 12));
	}

	async checkMac(purpose: string, value: string, mac: string): Promise<boolean> {
		return timingSafeEqual(mac, await this.mac(purpose, value));
	}

	/** Derives a stable sub-secret, e.g. for the default webhook token. */
	async derive(label: string): Promise<string> {
		return b64.url((await hmacSha256(this.#secret, `derive:${label}`)).subarray(0, 24));
	}

	// AES-GCM for secrets at rest (provider API keys and passwords).
	async #aesKey(): Promise<CryptoKey> {
		const raw = await hmacSha256(this.#secret, "emdash-newsletters:settings-encryption");
		return subtle().importKey("raw", new Uint8Array(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
	}

	async encrypt(plain: string): Promise<string> {
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv }, await this.#aesKey(), utf8.encode(plain)));
		return `enc:v1:${b64.url(iv)}:${b64.url(ct)}`;
	}

	async decrypt(value: string): Promise<string | null> {
		if (!value.startsWith("enc:v1:")) return value;
		const [, , ivS, ctS] = value.split(":");
		try {
			const pt = await subtle().decrypt({ name: "AES-GCM", iv: new Uint8Array(b64.fromUrl(ivS)) }, await this.#aesKey(), new Uint8Array(b64.fromUrl(ctS)));
			return new TextDecoder().decode(pt);
		} catch {
			return null;
		}
	}
}
