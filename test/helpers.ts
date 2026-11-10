import { DatabaseSync } from "node:sqlite";
import type { Db, DbStatement } from "../src/db.ts";
import { createNewsletter, type NewsletterOptions } from "../src/newsletter.ts";
import type { BatchItemResult, EmailTransport, OutboundEmail } from "../src/transport/types.ts";

/** D1-compatible wrapper over node:sqlite, so tests run the real SQL. */
export function sqliteDb(): Db & { raw: DatabaseSync } {
	const raw = new DatabaseSync(":memory:");
	raw.exec("PRAGMA foreign_keys = ON");
	const norm = (v: unknown) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v);
	function stmt(sql: string, values: unknown[] = []): DbStatement & { exec(): unknown } {
		const s: DbStatement & { exec(): unknown } = {
			bind: (...v: unknown[]) => stmt(sql, v),
			async first<T>() {
				const r = raw.prepare(sql).all(...(values.map(norm) as never[]));
				return (r[0] ?? null) as T | null;
			},
			async all<T>() {
				return { results: raw.prepare(sql).all(...(values.map(norm) as never[])) as T[] };
			},
			async run() {
				return s.exec();
			},
			exec() {
				if (/\bRETURNING\b/i.test(sql)) {
					const rows = raw.prepare(sql).all(...(values.map(norm) as never[]));
					return { meta: { changes: rows.length }, results: rows };
				}
				const r = raw.prepare(sql).run(...(values.map(norm) as never[]));
				return { meta: { changes: Number(r.changes) } };
			},
		};
		return s;
	}
	return {
		raw,
		prepare: (sql: string) => stmt(sql),
		async batch(statements) {
			raw.exec("BEGIN");
			try {
				const out = statements.map((s) => (s as unknown as { exec(): unknown }).exec());
				raw.exec("COMMIT");
				return out;
			} catch (err) {
				raw.exec("ROLLBACK");
				throw err;
			}
		},
	};
}

export interface FakeTransport extends EmailTransport {
	sent: OutboundEmail[];
	failNext?: (m: OutboundEmail) => BatchItemResult | undefined;
}

export function fakeTransport(maxBatch = 100): FakeTransport {
	const t: FakeTransport = {
		name: "fake",
		maxBatch,
		sent: [],
		async send(m) {
			const [r] = await t.sendBatch([m]);
			if (!r.ok) throw r.error;
			return { messageId: r.messageId };
		},
		async sendBatch(ms) {
			return ms.map((m) => {
				const forced = t.failNext?.(m);
				if (forced) return forced;
				t.sent.push(m);
				return { ok: true as const, messageId: `msg_${t.sent.length}` };
			});
		},
	};
	return t;
}

export const SECRET = "test-secret-that-is-long-enough";

export async function setup(extra: Partial<NewsletterOptions> = {}) {
	const db = sqliteDb();
	const transport = fakeTransport();
	const nl = createNewsletter({
		db,
		secret: SECRET,
		transport,
		logger: { info() {}, warn() {}, error() {} },
		...extra,
	});
	await nl.settings.update({
		publicationName: "Test Daily",
		siteUrl: "https://example.test",
		from: { email: "news@mail.example.test", name: "Test Daily" },
		postalAddress: "1 Test St, Testville",
		provider: { type: "bird", apiKey: "bk_us1_secretkey" },
	});
	return { db, nl, transport };
}

export function linksIn(html: string): string[] {
	return [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
}

export async function activeSubs(nl: Awaited<ReturnType<typeof setup>>["nl"], n: number, tags: string[] = []) {
	const out = [];
	for (let i = 0; i < n; i++) {
		const r = await nl.subscribers.subscribe({ email: `reader${i}@example.org`, firstName: `R${i}`, confirmed: true, tags });
		if ("subscriber" in r) out.push(r.subscriber);
	}
	return out;
}
