/**
 * Subscribers: sign-up with double opt-in, confirmation, unsubscribe,
 * preferences (topics), tags, referrals, import/export and GDPR deletion.
 */
import { enrollTrigger, stopRuns } from "./automations.ts";
import { type Core, mapSubscriber, type Subscriber, type SubscriberStatus } from "./core.ts";
import { changes } from "./db.ts";
import { CONFIRM_TTL, confirmUrl, preferencesUrl, unsubscribeUrl } from "./links.ts";
import { applyMergeTags, emailStyles, layout, renderBody } from "./render/email.ts";
import { drain, enqueueTransactional } from "./sender.ts";
import type { NewsletterConfig } from "./settings.ts";
import { escapeHtml, newId, normalizeEmail, now, randomCode } from "./util.ts";

export interface SubscribeInput {
	email: string;
	firstName?: string;
	lastName?: string;
	source?: string;
	utm?: Record<string, string>;
	/** Referral code of the person who referred them. */
	ref?: string;
	/** Topic slugs to opt in to. Defaults to the configured default topics. */
	topics?: string[];
	tags?: string[];
	attributes?: Record<string, string>;
	ip?: string | null;
	/** Skip double opt-in (imports, already-verified members). */
	confirmed?: boolean;
}

export type SubscribeResult =
	| { status: "pending"; subscriber: Subscriber }
	| { status: "active"; subscriber: Subscriber }
	| { status: "already_active"; subscriber: Subscriber }
	| { status: "invalid_email" };

const clean = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) || null : null);

export async function getSubscriber(core: Core, id: string, withTags = false): Promise<Subscriber | null> {
	const r = await core.db
		.prepare(
			withTags
				? `SELECT s.*, (SELECT group_concat(tag, char(31)) FROM nl_tags t WHERE t.subscriber_id = s.id) AS tags FROM nl_subscribers s WHERE s.id = ?`
				: `SELECT * FROM nl_subscribers WHERE id = ?`,
		)
		.bind(id)
		.first();
	if (!r) return null;
	if (withTags && r.tags === null) r.tags = "";
	return mapSubscriber(r);
}

export async function getSubscriberByEmail(core: Core, email: string, withTags = false): Promise<Subscriber | null> {
	const e = normalizeEmail(email);
	if (!e) return null;
	const r = await core.db.prepare(`SELECT id FROM nl_subscribers WHERE email = ?`).bind(e).first<{ id: string }>();
	return r ? getSubscriber(core, r.id, withTags) : null;
}

async function topicTags(core: Core, config: NewsletterConfig, chosen?: string[]): Promise<string[]> {
	const { results } = await core.db.prepare(`SELECT slug, is_default FROM nl_topics`).all<{ slug: string; is_default: number }>();
	const known = new Set(results.map((r) => r.slug));
	let slugs: string[];
	if (chosen?.length) slugs = chosen.filter((s) => known.has(s));
	else if (config.defaultTopics.length) slugs = config.defaultTopics.filter((s) => known.has(s));
	else slugs = results.filter((r) => r.is_default).map((r) => r.slug);
	return slugs.map((s) => `topic:${s}`);
}

export async function addTags(core: Core, subscriberId: string, tags: string[], opts: { trigger?: boolean } = {}): Promise<string[]> {
	const list = [...new Set(tags.map((t) => t.trim().slice(0, 80)).filter(Boolean))];
	if (!list.length) return [];
	const results = await core.db.batch(
		list.map((t) => core.db.prepare(`INSERT OR IGNORE INTO nl_tags (subscriber_id, tag, created_at) VALUES (?, ?, ?)`).bind(subscriberId, t, now())),
	);
	const added = list.filter((_, i) => changes(results[i]) > 0);
	if (opts.trigger !== false && added.length) {
		const sub = await getSubscriber(core, subscriberId);
		if (sub?.status === "active") for (const t of added) await enrollTrigger(core, "tag_added", sub, t);
	}
	return added;
}

export async function removeTags(core: Core, subscriberId: string, tags: string[]): Promise<void> {
	if (!tags.length) return;
	await core.db.batch(tags.map((t) => core.db.prepare(`DELETE FROM nl_tags WHERE subscriber_id = ? AND tag = ?`).bind(subscriberId, t)));
}

/** Adds or confirms a subscriber. Sends the confirmation email when double opt-in is on. */
export async function subscribe(core: Core, input: SubscribeInput): Promise<SubscribeResult> {
	const email = normalizeEmail(input.email);
	if (!email) return { status: "invalid_email" };
	const config = await core.settings.get();
	const t = now();
	let sub = await getSubscriberByEmail(core, email);

	if (sub?.status === "active") {
		if (input.tags?.length) await addTags(core, sub.id, input.tags);
		if (input.topics?.length) await addTags(core, sub.id, await topicTags(core, config, input.topics));
		return { status: "already_active", subscriber: sub };
	}

	if (!sub) {
		let referredBy: string | null = null;
		if (input.ref) {
			const r = await core.db.prepare(`SELECT id FROM nl_subscribers WHERE referral_code = ?`).bind(input.ref.slice(0, 40)).first<{ id: string }>();
			referredBy = r?.id ?? null;
		}
		const id = newId("sub_");
		await core.db
			.prepare(
				`INSERT INTO nl_subscribers (id, email, status, first_name, last_name, attributes, source, utm, referral_code, referred_by, consent_ip, consent_at, created_at, updated_at)
				 VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT (email) DO NOTHING`,
			)
			.bind(
				id,
				email,
				clean(input.firstName, 80),
				clean(input.lastName, 80),
				JSON.stringify(input.attributes ?? {}),
				clean(input.source, 80),
				input.utm ? JSON.stringify(input.utm) : null,
				randomCode(8),
				referredBy,
				input.ip ?? null,
				t,
				t,
				t,
			)
			.run();
		sub = (await getSubscriberByEmail(core, email))!;
		await addTags(core, sub.id, [...(input.tags ?? []), ...(await topicTags(core, config, input.topics))], { trigger: false });
	} else {
		// Coming back after unsubscribing or bouncing: they must confirm again.
		await core.db
			.prepare(
				`UPDATE nl_subscribers SET status = 'pending', first_name = COALESCE(?, first_name), last_name = COALESCE(?, last_name),
				 consent_ip = ?, consent_at = ?, updated_at = ? WHERE id = ?`,
			)
			.bind(clean(input.firstName, 80), clean(input.lastName, 80), input.ip ?? null, t, t, sub.id)
			.run();
		if (input.tags?.length) await addTags(core, sub.id, input.tags, { trigger: false });
		if (input.topics?.length) await addTags(core, sub.id, await topicTags(core, config, input.topics), { trigger: false });
		sub = (await getSubscriber(core, sub.id))!;
	}

	if (input.confirmed || !config.doubleOptIn) {
		const active = await activate(core, sub.id);
		return { status: "active", subscriber: active ?? sub };
	}
	await sendConfirmation(core, config, sub);
	return { status: "pending", subscriber: sub };
}

/** Sends (or re-sends, at most every 2 minutes) the double opt-in email. */
export async function sendConfirmation(core: Core, config: NewsletterConfig, sub: Subscriber): Promise<boolean> {
	const recent = await core.db
		.prepare(`SELECT 1 FROM nl_outbox WHERE subscriber_id = ? AND kind = 'transactional' AND payload LIKE '%"category":"confirmation"%' AND created_at > ?`)
		.bind(sub.id, now() - 120_000)
		.first();
	if (recent) return false;
	const url = await confirmUrl(core, config, sub.id);
	const vars = { publication: config.publicationName, first_name: sub.firstName, email: sub.email };
	const styles = emailStyles(config.brand.accentColor);
	const intro = applyMergeTags(config.confirmation.intro, vars, "text");
	const body = renderBody(
		"markdown",
		`${intro}\n\n[[Confirm my subscription]](${url})\n\nIf you didn't ask to subscribe, ignore this email and you won't hear from us.`,
		styles,
	);
	const done = layout({
		config,
		subject: applyMergeTags(config.confirmation.subject, vars, "text"),
		bodyHtml: body.html,
		bodyText: body.text,
		unsubscribeUrl: await unsubscribeUrl(core, config, sub.id),
		preferencesUrl: await preferencesUrl(core, config, sub.id),
		compact: false,
		reason: `Someone (hopefully you) entered ${sub.email} to subscribe to ${config.publicationName}.`,
	});
	const id = await enqueueTransactional(core, {
		email: sub.email,
		subscriberId: sub.id,
		subject: applyMergeTags(config.confirmation.subject, vars, "text"),
		html: done.html,
		text: done.text,
		category: "confirmation",
		priority: 0,
	});
	// Send right away; if the provider is down the row stays queued for the next tick.
	await drain(core, { ids: [id] }).catch((err) => core.log.warn("confirmation send failed", { error: String(err) }));
	return true;
}

export async function confirmByToken(core: Core, token: unknown): Promise<Subscriber | null> {
	return (await confirmToken(core, token))?.subscriber ?? null;
}

export interface ConfirmResult {
	subscriber: Subscriber;
	/** True when this call did the confirming; false when they were already active. */
	firstConfirmation: boolean;
	/** When the confirmation link was created (ms), if the token says. */
	sentAt: number | null;
}

/** Like `confirmByToken`, and also says whether this was the confirming click and when the link was sent. */
export async function confirmToken(core: Core, token: unknown): Promise<ConfirmResult | null> {
	const data = await core.signer.verify<{ s: string; x?: number }>("confirm", token);
	if (!data?.s) return null;
	const sub = await getSubscriber(core, data.s);
	if (!sub) return null;
	const sentAt = typeof data.x === "number" ? data.x - CONFIRM_TTL : null;
	if (sub.status === "active") return { subscriber: sub, firstConfirmation: false, sentAt };
	const after = await activate(core, sub.id);
	return after ? { subscriber: after, firstConfirmation: after.status === "active", sentAt } : null;
}

/** Marks a subscriber active and runs everything that hangs off that. Idempotent. */
export async function activate(core: Core, id: string): Promise<Subscriber | null> {
	const t = now();
	const res = await core.db
		.prepare(`UPDATE nl_subscribers SET status = 'active', confirmed_at = COALESCE(confirmed_at, ?), unsubscribed_at = NULL, updated_at = ? WHERE id = ? AND status <> 'active'`)
		.bind(t, t, id)
		.run();
	const sub = await getSubscriber(core, id);
	if (!sub || changes(res) === 0) return sub;
	await core.db.prepare(`DELETE FROM nl_suppressions WHERE email = ? AND reason <> 'complaint'`).bind(sub.email).run();
	await core.db.prepare(`INSERT INTO nl_events (type, subscriber_id, created_at) VALUES ('subscribed', ?, ?)`).bind(id, t).run();
	const config = await core.settings.get();
	if (config.welcome.enabled) await sendWelcome(core, config, sub).catch((err) => core.log.warn("welcome send failed", { error: String(err) }));
	await enrollTrigger(core, "subscribed", sub);
	if (sub.referredBy) await creditReferral(core, config, sub.referredBy);
	try {
		await core.hooks.onSubscribed?.(sub);
	} catch (err) {
		core.log.error("onSubscribed hook failed", { error: String(err) });
	}
	return sub;
}

async function sendWelcome(core: Core, config: NewsletterConfig, sub: Subscriber) {
	const vars = { publication: config.publicationName, first_name: sub.firstName, email: sub.email };
	const body = renderBody("markdown", applyMergeTags(config.welcome.content, vars, "text"), emailStyles(config.brand.accentColor));
	const unsub = await unsubscribeUrl(core, config, sub.id);
	const subject = applyMergeTags(config.welcome.subject, vars, "text");
	const done = layout({ config, subject, bodyHtml: body.html, bodyText: body.text, unsubscribeUrl: unsub, preferencesUrl: await preferencesUrl(core, config, sub.id) });
	await enqueueTransactional(core, {
		email: sub.email,
		subscriberId: sub.id,
		subject,
		html: done.html,
		text: done.text,
		category: "welcome",
		headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
	});
}

async function creditReferral(core: Core, config: NewsletterConfig, referrerId: string) {
	if (!config.referrals.enabled) return;
	const referrer = await getSubscriber(core, referrerId);
	if (!referrer || referrer.status !== "active") return;
	const r = await core.db
		.prepare(`SELECT COUNT(*) AS n FROM nl_subscribers WHERE referred_by = ? AND status = 'active'`)
		.bind(referrerId)
		.first<{ n: number }>();
	const count = r?.n ?? 0;
	for (const m of config.referrals.milestones) {
		if (count < m.count) continue;
		const tag = m.tag || `referral:${m.count}`;
		const added = await addTags(core, referrerId, [tag]);
		if (added.length === 0) continue; // already rewarded
		await core.db
			.prepare(`INSERT INTO nl_events (type, subscriber_id, meta, created_at) VALUES ('referral_milestone', ?, ?, ?)`)
			.bind(referrerId, JSON.stringify({ count: m.count, reward: m.reward }), now())
			.run();
		try {
			await core.hooks.onReferralMilestone?.(referrer, m, count);
		} catch (err) {
			core.log.error("onReferralMilestone hook failed", { error: String(err) });
		}
	}
}

export async function unsubscribe(
	core: Core,
	subscriberId: string,
	reason: "link" | "one_click" | "provider" | "admin" | "complaint" | "bounce" = "link",
	campaignId?: string | null,
): Promise<Subscriber | null> {
	const status: SubscriberStatus = reason === "complaint" ? "complained" : reason === "bounce" ? "bounced" : "unsubscribed";
	const t = now();
	const res = await core.db
		.prepare(`UPDATE nl_subscribers SET status = ?, unsubscribed_at = ?, updated_at = ? WHERE id = ? AND status IN ('active','pending')`)
		.bind(status, t, t, subscriberId)
		.run();
	const sub = await getSubscriber(core, subscriberId);
	if (!sub || changes(res) === 0) return sub;
	const eventType = status === "unsubscribed" ? "unsubscribed" : status === "complained" ? "complained" : "bounced";
	await core.db
		.prepare(`INSERT INTO nl_events (type, campaign_id, subscriber_id, meta, created_at) VALUES (?, ?, ?, ?, ?)`)
		.bind(eventType, campaignId ?? null, subscriberId, JSON.stringify({ reason }), t)
		.run();
	if (status !== "unsubscribed") {
		await core.db
			.prepare(`INSERT OR REPLACE INTO nl_suppressions (email, reason, created_at) VALUES (?, ?, ?)`)
			.bind(sub.email, status === "complained" ? "complaint" : "hard_bounce", t)
			.run();
	}
	await core.db.prepare(`UPDATE nl_outbox SET status = 'canceled' WHERE subscriber_id = ? AND status = 'queued' AND kind <> 'transactional'`).bind(subscriberId).run();
	await stopRuns(core, subscriberId);
	try {
		await core.hooks.onUnsubscribed?.(sub, reason);
	} catch (err) {
		core.log.error("onUnsubscribed hook failed", { error: String(err) });
	}
	return sub;
}

export async function unsubscribeByToken(core: Core, token: unknown, reason: "link" | "one_click" = "link"): Promise<Subscriber | null> {
	const data = await core.signer.verify<{ s: string; c?: string }>("unsub", token);
	if (!data?.s) return null;
	return unsubscribe(core, data.s, reason, data.c);
}

export interface Topic {
	slug: string;
	name: string;
	description: string | null;
	isPublic: boolean;
	isDefault: boolean;
	sort: number;
}

export async function listTopics(core: Core, publicOnly = false): Promise<Topic[]> {
	const { results } = await core.db.prepare(`SELECT * FROM nl_topics ${publicOnly ? "WHERE is_public = 1" : ""} ORDER BY sort, name`).all();
	return results.map((r) => ({
		slug: r.slug as string,
		name: r.name as string,
		description: (r.description as string) ?? null,
		isPublic: !!r.is_public,
		isDefault: !!r.is_default,
		sort: r.sort as number,
	}));
}

export async function saveTopic(core: Core, t: { slug: string; name: string; description?: string; isPublic?: boolean; isDefault?: boolean; sort?: number }): Promise<void> {
	const slug = t.slug.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40);
	if (!slug) throw new Error("Topic slug is required");
	await core.db
		.prepare(
			`INSERT INTO nl_topics (slug, name, description, is_public, is_default, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (slug) DO UPDATE SET name = excluded.name, description = excluded.description, is_public = excluded.is_public, is_default = excluded.is_default, sort = excluded.sort`,
		)
		.bind(slug, t.name.slice(0, 80), t.description ?? null, t.isPublic === false ? 0 : 1, t.isDefault === false ? 0 : 1, t.sort ?? 0, now())
		.run();
}

export async function deleteTopic(core: Core, slug: string): Promise<void> {
	await core.db.batch([
		core.db.prepare(`DELETE FROM nl_topics WHERE slug = ?`).bind(slug),
		core.db.prepare(`DELETE FROM nl_tags WHERE tag = ?`).bind(`topic:${slug}`),
	]);
}

/** Preference-center save: name and topic choices. Choosing no topics keeps them subscribed to nothing topic-specific. */
export async function updatePreferences(
	core: Core,
	subscriberId: string,
	input: { firstName?: string; lastName?: string; topics?: string[] },
): Promise<Subscriber | null> {
	await core.db
		.prepare(`UPDATE nl_subscribers SET first_name = COALESCE(?, first_name), last_name = COALESCE(?, last_name), updated_at = ? WHERE id = ?`)
		.bind(clean(input.firstName, 80), clean(input.lastName, 80), now(), subscriberId)
		.run();
	if (input.topics) {
		const all = await listTopics(core, true);
		const want = new Set(input.topics);
		await removeTags(core, subscriberId, all.filter((t) => !want.has(t.slug)).map((t) => `topic:${t.slug}`));
		await addTags(core, subscriberId, all.filter((t) => want.has(t.slug)).map((t) => `topic:${t.slug}`));
	}
	return getSubscriber(core, subscriberId, true);
}

export async function updateSubscriber(
	core: Core,
	id: string,
	input: { firstName?: string | null; lastName?: string | null; attributes?: Record<string, string>; status?: SubscriberStatus },
): Promise<Subscriber | null> {
	const cur = await getSubscriber(core, id);
	if (!cur) return null;
	await core.db
		.prepare(`UPDATE nl_subscribers SET first_name = ?, last_name = ?, attributes = ?, updated_at = ? WHERE id = ?`)
		.bind(
			input.firstName === undefined ? cur.firstName : clean(input.firstName, 80),
			input.lastName === undefined ? cur.lastName : clean(input.lastName, 80),
			JSON.stringify(input.attributes ? { ...cur.attributes, ...input.attributes } : cur.attributes),
			now(),
			id,
		)
		.run();
	if (input.status && input.status !== cur.status) {
		if (input.status === "active") await activate(core, id);
		else if (input.status === "unsubscribed") await unsubscribe(core, id, "admin");
	}
	return getSubscriber(core, id, true);
}

export interface ListQuery {
	search?: string;
	status?: SubscriberStatus | "";
	tag?: string;
	limit?: number;
	offset?: number;
}

export async function listSubscribers(core: Core, q: ListQuery = {}): Promise<{ items: Subscriber[]; total: number }> {
	const where: string[] = [];
	const binds: unknown[] = [];
	if (q.search) {
		where.push("(s.email LIKE ? OR s.first_name LIKE ? OR s.last_name LIKE ?)");
		const like = `%${q.search.trim().toLowerCase()}%`;
		binds.push(like, like, like);
	}
	if (q.status) {
		where.push("s.status = ?");
		binds.push(q.status);
	}
	if (q.tag) {
		where.push("EXISTS (SELECT 1 FROM nl_tags t WHERE t.subscriber_id = s.id AND t.tag = ?)");
		binds.push(q.tag);
	}
	const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
	const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
	const [{ results }, total] = await Promise.all([
		core.db
			.prepare(
				`SELECT s.*, COALESCE((SELECT group_concat(tag, char(31)) FROM nl_tags t WHERE t.subscriber_id = s.id), '') AS tags
				 FROM nl_subscribers s ${w} ORDER BY s.created_at DESC LIMIT ? OFFSET ?`,
			)
			.bind(...binds, limit, Math.max(q.offset ?? 0, 0))
			.all(),
		core.db.prepare(`SELECT COUNT(*) AS n FROM nl_subscribers s ${w}`).bind(...binds).first<{ n: number }>(),
	]);
	return { items: results.map(mapSubscriber), total: total?.n ?? 0 };
}

/** GDPR erasure: removes the subscriber and anonymises their send history. */
export async function deleteSubscriber(core: Core, id: string): Promise<boolean> {
	const sub = await getSubscriber(core, id);
	if (!sub) return false;
	await core.db.batch([
		core.db.prepare(`UPDATE nl_outbox SET email = 'deleted', payload = NULL, subscriber_id = NULL, status = CASE WHEN status = 'queued' THEN 'canceled' ELSE status END WHERE subscriber_id = ?`).bind(id),
		core.db.prepare(`UPDATE nl_events SET subscriber_id = NULL, meta = NULL WHERE subscriber_id = ?`).bind(id),
		core.db.prepare(`UPDATE nl_subscribers SET referred_by = NULL WHERE referred_by = ?`).bind(id),
		core.db.prepare(`DELETE FROM nl_tags WHERE subscriber_id = ?`).bind(id),
		core.db.prepare(`DELETE FROM nl_automation_runs WHERE subscriber_id = ?`).bind(id),
		core.db.prepare(`DELETE FROM nl_subscribers WHERE id = ?`).bind(id),
	]);
	return true;
}

export async function referralStats(core: Core, limit = 20): Promise<{ email: string; referrals: number }[]> {
	const { results } = await core.db
		.prepare(
			`SELECT r.email, COUNT(*) AS referrals FROM nl_subscribers s JOIN nl_subscribers r ON r.id = s.referred_by
			 WHERE s.status = 'active' GROUP BY r.id ORDER BY referrals DESC LIMIT ?`,
		)
		.bind(limit)
		.all<{ email: string; referrals: number }>();
	return results;
}

// ─────────────────────────────────── CSV ───────────────────────────────────

export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quoted) {
			if (ch === '"' && text[i + 1] === '"') {
				field += '"';
				i++;
			} else if (ch === '"') quoted = false;
			else field += ch;
		} else if (ch === '"') quoted = true;
		else if (ch === ",") {
			row.push(field);
			field = "";
		} else if (ch === "\n" || ch === "\r") {
			if (ch === "\r" && text[i + 1] === "\n") i++;
			row.push(field);
			if (row.some((f) => f.trim())) rows.push(row);
			row = [];
			field = "";
		} else field += ch;
	}
	row.push(field);
	if (row.some((f) => f.trim())) rows.push(row);
	return rows;
}

const csvCell = (v: unknown) => {
	const s = v === null || v === undefined ? "" : String(v);
	// Neutralise spreadsheet formula injection.
	const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
	return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export interface ImportResult {
	added: number;
	updated: number;
	invalid: number;
	total: number;
}

/**
 * Imports CSV with a header row. Recognised columns: email (required),
 * first_name, last_name, tags (semicolon-separated), source; any other column
 * becomes an attribute. Imported contacts are active (you vouch for consent)
 * unless `status: "pending"`, which sends each a confirmation email.
 */
export async function importCsv(core: Core, csv: string, opts: { tags?: string[]; status?: "active" | "pending"; source?: string } = {}): Promise<ImportResult> {
	const rows = parseCsv(csv);
	const result: ImportResult = { added: 0, updated: 0, invalid: 0, total: Math.max(0, rows.length - 1) };
	if (rows.length < 2) return result;
	const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
	const col = (name: string) => header.indexOf(name);
	const ei = col("email") >= 0 ? col("email") : col("email_address");
	if (ei < 0) throw new Error("CSV needs an email column");
	const known = new Set(["email", "email_address", "first_name", "last_name", "tags", "source", "name"]);
	for (const r of rows.slice(1)) {
		const email = normalizeEmail(r[ei]);
		if (!email) {
			result.invalid++;
			continue;
		}
		const attributes: Record<string, string> = {};
		header.forEach((h, i) => {
			if (!known.has(h) && r[i]?.trim()) attributes[h.replace(/[^a-z0-9_-]/g, "")] = r[i].trim().slice(0, 500);
		});
		let first = col("first_name") >= 0 ? r[col("first_name")] : undefined;
		let last = col("last_name") >= 0 ? r[col("last_name")] : undefined;
		if (!first && col("name") >= 0 && r[col("name")]) [first, last] = r[col("name")].trim().split(/\s+(.+)/);
		const tags = [...(opts.tags ?? []), ...(col("tags") >= 0 ? (r[col("tags")] ?? "").split(/[;|]/) : [])].map((t) => t.trim()).filter(Boolean);
		const existing = await getSubscriberByEmail(core, email);
		if (existing) {
			await updateSubscriber(core, existing.id, { firstName: first || undefined, lastName: last || undefined, attributes });
			if (tags.length) await addTags(core, existing.id, tags);
			result.updated++;
			continue;
		}
		await subscribe(core, {
			email,
			firstName: first,
			lastName: last,
			source: (col("source") >= 0 && r[col("source")]) || opts.source || "import",
			tags,
			attributes,
			confirmed: opts.status !== "pending",
		});
		result.added++;
	}
	return result;
}

export async function exportCsv(core: Core, opts: { status?: SubscriberStatus | ""; limit?: number } = {}): Promise<string> {
	const { items } = await listSubscribers(core, { status: opts.status, limit: Math.min(opts.limit ?? 500, 500) });
	let all = items;
	// Page through for big lists.
	for (let offset = items.length; items.length === 500 && offset < (opts.limit ?? 50_000); offset += 500) {
		const page = await listSubscribers(core, { status: opts.status, limit: 500, offset });
		all = all.concat(page.items);
		if (page.items.length < 500) break;
	}
	const head = ["email", "status", "first_name", "last_name", "tags", "source", "referral_code", "created_at", "confirmed_at"];
	const lines = all.map((s) =>
		[
			s.email,
			s.status,
			s.firstName,
			s.lastName,
			(s.tags ?? []).join(";"),
			s.source,
			s.referralCode,
			new Date(s.createdAt).toISOString(),
			s.confirmedAt ? new Date(s.confirmedAt).toISOString() : "",
		]
			.map(csvCell)
			.join(","),
	);
	return [head.join(","), ...lines].join("\n");
}

export { escapeHtml };
