/**
 * The slice of Cloudflare D1 this package uses, declared structurally so the
 * package doesn't depend on Workers types and tests can pass any compatible
 * implementation (for example a node:sqlite wrapper).
 */
export interface DbStatement {
	bind(...values: unknown[]): DbStatement;
	first<T = Record<string, unknown>>(): Promise<T | null>;
	all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
	run(): Promise<{ meta?: { changes?: number } } | unknown>;
}

export interface Db {
	prepare(query: string): DbStatement;
	batch(statements: DbStatement[]): Promise<unknown[]>;
}

/** Rows changed by a `run()`, when the driver reports it. */
export function changes(result: unknown): number {
	const meta = (result as { meta?: { changes?: number } } | null)?.meta;
	return typeof meta?.changes === "number" ? meta.changes : 0;
}

/**
 * Migrations, applied in order. Never edit a shipped migration; append one.
 * Each migration runs in one D1 batch (one transaction).
 */
const MIGRATIONS: string[][] = [
	[
		`CREATE TABLE IF NOT EXISTS nl_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS nl_subscribers (
			id TEXT PRIMARY KEY,
			email TEXT NOT NULL UNIQUE,
			status TEXT NOT NULL,
			first_name TEXT,
			last_name TEXT,
			attributes TEXT NOT NULL DEFAULT '{}',
			source TEXT,
			utm TEXT,
			referral_code TEXT NOT NULL UNIQUE,
			referred_by TEXT,
			consent_ip TEXT,
			consent_at INTEGER,
			confirmed_at INTEGER,
			unsubscribed_at INTEGER,
			last_open_at INTEGER,
			last_click_at INTEGER,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS nl_subscribers_status ON nl_subscribers (status, created_at)`,
		`CREATE INDEX IF NOT EXISTS nl_subscribers_referred_by ON nl_subscribers (referred_by)`,
		`CREATE TABLE IF NOT EXISTS nl_tags (
			subscriber_id TEXT NOT NULL REFERENCES nl_subscribers (id) ON DELETE CASCADE,
			tag TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			PRIMARY KEY (subscriber_id, tag)
		)`,
		`CREATE INDEX IF NOT EXISTS nl_tags_tag ON nl_tags (tag)`,
		`CREATE TABLE IF NOT EXISTS nl_topics (
			slug TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			description TEXT,
			is_public INTEGER NOT NULL DEFAULT 1,
			is_default INTEGER NOT NULL DEFAULT 1,
			sort INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS nl_suppressions (email TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at INTEGER NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS nl_segments (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			rules TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS nl_campaigns (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			subject TEXT NOT NULL,
			subject_b TEXT,
			preheader TEXT,
			from_name TEXT,
			from_email TEXT,
			reply_to TEXT,
			content_format TEXT NOT NULL DEFAULT 'markdown',
			content TEXT NOT NULL DEFAULT '',
			segment_id TEXT,
			audience TEXT,
			status TEXT NOT NULL DEFAULT 'draft',
			scheduled_at INTEGER,
			started_at INTEGER,
			sent_at INTEGER,
			ab_test_pct INTEGER NOT NULL DEFAULT 0,
			ab_wait_minutes INTEGER NOT NULL DEFAULT 240,
			ab_metric TEXT NOT NULL DEFAULT 'clicks',
			ab_winner TEXT,
			ab_decide_at INTEGER,
			source_ref TEXT UNIQUE,
			web_slug TEXT UNIQUE,
			publish_web INTEGER NOT NULL DEFAULT 0,
			web_access TEXT NOT NULL DEFAULT 'public',
			track_opens INTEGER NOT NULL DEFAULT 1,
			track_clicks INTEGER NOT NULL DEFAULT 1,
			recipients_total INTEGER NOT NULL DEFAULT 0,
			error TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS nl_campaigns_status ON nl_campaigns (status, scheduled_at)`,
		`CREATE TABLE IF NOT EXISTS nl_links (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			scope TEXT NOT NULL,
			url TEXT NOT NULL,
			UNIQUE (scope, url)
		)`,
		`CREATE TABLE IF NOT EXISTS nl_outbox (
			id TEXT PRIMARY KEY,
			kind TEXT NOT NULL,
			campaign_id TEXT,
			automation_id TEXT,
			step INTEGER,
			subscriber_id TEXT,
			email TEXT NOT NULL,
			variant TEXT,
			payload TEXT,
			status TEXT NOT NULL DEFAULT 'queued',
			priority INTEGER NOT NULL DEFAULT 5,
			attempts INTEGER NOT NULL DEFAULT 0,
			next_attempt_at INTEGER NOT NULL,
			locked_until INTEGER,
			provider TEXT,
			provider_message_id TEXT,
			error TEXT,
			created_at INTEGER NOT NULL,
			sent_at INTEGER
		)`,
		`CREATE INDEX IF NOT EXISTS nl_outbox_queue ON nl_outbox (status, priority, next_attempt_at)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS nl_outbox_campaign ON nl_outbox (campaign_id, subscriber_id) WHERE campaign_id IS NOT NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS nl_outbox_automation ON nl_outbox (automation_id, step, subscriber_id) WHERE automation_id IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS nl_outbox_provider_id ON nl_outbox (provider_message_id)`,
		`CREATE INDEX IF NOT EXISTS nl_outbox_subscriber ON nl_outbox (subscriber_id, created_at)`,
		`CREATE TABLE IF NOT EXISTS nl_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			type TEXT NOT NULL,
			outbox_id TEXT,
			campaign_id TEXT,
			subscriber_id TEXT,
			link_id INTEGER,
			variant TEXT,
			meta TEXT,
			created_at INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS nl_events_campaign ON nl_events (campaign_id, type)`,
		`CREATE INDEX IF NOT EXISTS nl_events_subscriber ON nl_events (subscriber_id, created_at)`,
		`CREATE INDEX IF NOT EXISTS nl_events_time ON nl_events (created_at)`,
		`CREATE TABLE IF NOT EXISTS nl_automations (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			trigger TEXT NOT NULL,
			trigger_value TEXT,
			status TEXT NOT NULL DEFAULT 'paused',
			steps TEXT NOT NULL DEFAULT '[]',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS nl_automation_runs (
			automation_id TEXT NOT NULL REFERENCES nl_automations (id) ON DELETE CASCADE,
			subscriber_id TEXT NOT NULL REFERENCES nl_subscribers (id) ON DELETE CASCADE,
			step INTEGER NOT NULL DEFAULT 0,
			next_at INTEGER NOT NULL,
			status TEXT NOT NULL DEFAULT 'active',
			created_at INTEGER NOT NULL,
			PRIMARY KEY (automation_id, subscriber_id)
		)`,
		`CREATE INDEX IF NOT EXISTS nl_automation_runs_due ON nl_automation_runs (status, next_at)`,
		`CREATE TABLE IF NOT EXISTS nl_webhook_seen (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS nl_rate (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL)`,
	],
	// 2: automation exit tags, sponsor slots
	[
		`ALTER TABLE nl_automations ADD COLUMN exit_tag TEXT`,
		`CREATE TABLE IF NOT EXISTS nl_sponsor_slots (
			id TEXT PRIMARY KEY,
			date TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'booked',
			sponsor TEXT NOT NULL,
			headline TEXT NOT NULL,
			body TEXT NOT NULL DEFAULT '',
			url TEXT NOT NULL,
			cta_label TEXT,
			image_url TEXT,
			contact_email TEXT,
			price_cents INTEGER,
			notes TEXT,
			campaign_id TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
		// One live booking per date; canceled rows don't block the date.
		`CREATE UNIQUE INDEX IF NOT EXISTS nl_sponsor_slots_date ON nl_sponsor_slots (date) WHERE status <> 'canceled'`,
	],
];

const ready = new WeakMap<Db, Promise<void>>();

/** Brings the schema up to date once per isolate per database. */
export function ensureSchema(db: Db): Promise<void> {
	let p = ready.get(db);
	if (!p) {
		p = migrate(db).catch((err) => {
			ready.delete(db);
			throw err;
		});
		ready.set(db, p);
	}
	return p;
}

async function migrate(db: Db): Promise<void> {
	await db.prepare(`CREATE TABLE IF NOT EXISTS nl_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`).run();
	const row = await db.prepare(`SELECT value FROM nl_meta WHERE key = 'schema_version'`).first<{ value: string }>();
	let version = row ? Number(row.value) : 0;
	while (version < MIGRATIONS.length) {
		const next = version + 1;
		await db.batch([
			...MIGRATIONS[version].map((sql) => db.prepare(sql)),
			db
				.prepare(
					`INSERT INTO nl_meta (key, value) VALUES ('schema_version', ?)
					 ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
				)
				.bind(String(next)),
		]);
		version = next;
	}
}
