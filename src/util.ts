export const now = () => Date.now();

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;

export function normalizeEmail(input: unknown): string | null {
	if (typeof input !== "string") return null;
	const e = input.trim().toLowerCase();
	return e.length <= 254 && EMAIL.test(e) ? e : null;
}

/** Sortable, URL-safe random id: 10 chars of time + 16 chars of randomness. */
export function newId(prefix = ""): string {
	const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
	let t = Date.now();
	let time = "";
	for (let i = 0; i < 10; i++) {
		time = alphabet[t % 32] + time;
		t = Math.floor(t / 32);
	}
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	let rand = "";
	for (const b of bytes) rand += alphabet[b % 32];
	return prefix + time + rand;
}

export function randomCode(len = 8): string {
	const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
	const bytes = crypto.getRandomValues(new Uint8Array(len));
	let s = "";
	for (const b of bytes) s += alphabet[b % alphabet.length];
	return s;
}

export function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function stripHtml(html: string): string {
	return html
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

export function slugify(s: string): string {
	return (
		s
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[̀-ͯ]/g, "")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 80) || "issue"
	);
}

export function parseJson<T>(s: unknown, fallback: T): T {
	if (typeof s !== "string" || !s) return fallback;
	try {
		return JSON.parse(s) as T;
	} catch {
		return fallback;
	}
}

export const b64 = {
	encode(bytes: Uint8Array): string {
		let s = "";
		for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		return btoa(s);
	},
	decode(s: string): Uint8Array {
		const bin = atob(s);
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	},
	url(bytes: Uint8Array): string {
		return b64.encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	},
	fromUrl(s: string): Uint8Array {
		const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
		return b64.decode(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
	},
};

export const utf8 = new TextEncoder();

/** Next occurrence of HH:MM in an IANA time zone, as epoch ms (strictly after `from`). */
export function nextTimeInZone(hhmm: string, timeZone: string, from = Date.now()): number {
	const [h, m] = hhmm.split(":").map((n) => Number(n));
	for (let dayOffset = 0; dayOffset < 3; dayOffset++) {
		const probe = new Date(from + dayOffset * 86400000);
		const parts = zonedParts(probe, timeZone);
		const guess = Date.UTC(parts.year, parts.month - 1, parts.day, h, m || 0);
		// Correct for the zone offset at that wall-clock time.
		const offset = zoneOffset(guess, timeZone);
		const ts = guess - offset;
		if (ts > from) return ts;
	}
	return from + 86400000;
}

/** The calendar date ("2026-11-09") of an instant in an IANA time zone. */
export function dateInZone(ms: number, timeZone: string): string {
	let p: ReturnType<typeof zonedParts>;
	try {
		p = zonedParts(new Date(ms), timeZone);
	} catch {
		p = zonedParts(new Date(ms), "UTC");
	}
	return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** "2026-11-09" + "06:00" in a time zone → epoch ms. Returns NaN for bad input. */
export function zonedTimeToUtc(date: string, hhmm: string, timeZone: string): number {
	const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
	const t = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
	if (!d || !t) return Number.NaN;
	const guess = Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2]);
	try {
		return guess - zoneOffset(guess - zoneOffset(guess, timeZone), timeZone);
	} catch {
		return Number.NaN;
	}
}

/** Formats epoch ms in a time zone, e.g. "Nov 9, 2026, 6:00 AM". */
export function formatInZone(ms: number | null | undefined, timeZone: string): string {
	if (!ms) return "";
	try {
		return new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));
	} catch {
		return new Date(ms).toISOString();
	}
}

function zonedParts(d: Date, timeZone: string) {
	const f = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	});
	const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
	return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute };
}

function zoneOffset(utcMs: number, timeZone: string): number {
	const p = zonedParts(new Date(utcMs), timeZone);
	return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(utcMs / 60000) * 60000;
}
