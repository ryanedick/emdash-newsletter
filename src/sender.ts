/**
 * The outbox: every email (campaign, automation step, confirmation, test) is a
 * row in `nl_outbox`. `drain()` claims due rows, renders them per recipient and
 * hands them to the provider in native batches, honouring the per-minute send
 * rate, retrying transient failures with backoff and never sending a row twice.
 */
import { type Campaign, getCampaign } from "./campaigns.ts";
import { type Core, mapSubscriber, type Subscriber } from "./core.ts";
import { changes } from "./db.ts";
import { clickUrl, openPixelUrl, preferencesUrl, referralUrl, unsubscribeUrl, webIssueUrl } from "./links.ts";
import { applyMergeTags, collectLinks, emailStyles, layout, type MergeVars, renderBody, rewriteLinks } from "./render/email.ts";
import type { NewsletterConfig } from "./settings.ts";
import { markSponsorSent, renderSponsorBlock, sponsorForDate } from "./sponsors.ts";
import type { EmailSendError, EmailTransport, OutboundEmail } from "./transport/types.ts";
import { dateInZone, newId, now, parseJson } from "./util.ts";

const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000];
const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
const LOCK_MS = 5 * 60_000;

export interface OutboxRow {
	id: string;
	kind: "campaign" | "automation" | "transactional";
	campaign_id: string | null;
	automation_id: string | null;
	step: number | null;
	subscriber_id: string | null;
	email: string;
	variant: string | null;
	payload: string | null;
	attempts: number;
}

export interface TransactionalPayload {
	subject: string;
	html: string;
	text: string;
	category?: string;
	headers?: Record<string, string>;
}

export async function enqueueTransactional(
	core: Core,
	input: TransactionalPayload & { email: string; subscriberId?: string | null; priority?: number },
): Promise<string> {
	const id = newId("ob_");
	const { email, subscriberId, priority, ...payload } = input;
	await core.db
		.prepare(
			`INSERT INTO nl_outbox (id, kind, subscriber_id, email, payload, priority, next_attempt_at, created_at)
			 VALUES (?, 'transactional', ?, ?, ?, ?, ?, ?)`,
		)
		.bind(id, subscriberId ?? null, email, JSON.stringify(payload), priority ?? 1, now(), now())
		.run();
	return id;
}

/** Returns how many sends the per-minute budget still allows, and reserves them. */
async function reserveRate(core: Core, perMinute: number, want: number): Promise<number> {
	const windowStart = Math.floor(now() / 60_000) * 60_000;
	const row = await core.db
		.prepare(
			`INSERT INTO nl_rate (key, window_start, count) VALUES ('send', ?, 0)
			 ON CONFLICT (key) DO UPDATE SET window_start = excluded.window_start,
			   count = CASE WHEN nl_rate.window_start = excluded.window_start THEN nl_rate.count ELSE 0 END
			 RETURNING count`,
		)
		.bind(windowStart)
		.first<{ count: number }>();
	const used = row?.count ?? 0;
	const grant = Math.max(0, Math.min(want, perMinute - used));
	if (grant > 0) {
		await core.db.prepare(`UPDATE nl_rate SET count = count + ? WHERE key = 'send'`).bind(grant).run();
	}
	return grant;
}

async function releaseRate(core: Core, unused: number) {
	if (unused > 0) await core.db.prepare(`UPDATE nl_rate SET count = MAX(0, count - ?) WHERE key = 'send'`).bind(unused).run();
}

async function claim(core: Core, limit: number, ids?: string[]): Promise<OutboxRow[]> {
	const t = now();
	const idFilter = ids?.length ? ` AND id IN (${ids.map(() => "?").join(",")})` : "";
	const { results } = await core.db
		.prepare(
			`UPDATE nl_outbox SET status = 'sending', locked_until = ?, attempts = attempts + 1
			 WHERE id IN (
			   SELECT id FROM nl_outbox WHERE status = 'queued' AND next_attempt_at <= ?${idFilter}
			   ORDER BY priority, next_attempt_at LIMIT ?
			 ) AND status = 'queued'
			 RETURNING id, kind, campaign_id, automation_id, step, subscriber_id, email, variant, payload, attempts`,
		)
		.bind(t + LOCK_MS, t, ...(ids ?? []), limit)
		.all<OutboxRow>();
	return results;
}

/** Puts rows whose worker died mid-send back in the queue. */
async function recoverStale(core: Core) {
	await core.db
		.prepare(`UPDATE nl_outbox SET status = 'queued', next_attempt_at = ? WHERE status = 'sending' AND locked_until < ?`)
		.bind(now(), now())
		.run();
}

// ─────────────────────────── per-drain render cache ───────────────────────────

export interface Template {
	subjectA: string;
	subjectB: string | null;
	preheader: string;
	html: string;
	text: string;
	links: Map<string, number>;
	from: { email: string; name?: string };
	replyTo?: string;
	webUrl?: string;
	trackOpens: boolean;
	trackClicks: boolean;
	category: string;
	referrals: boolean;
	campaignId: string | null;
	/** The day's sponsor ad, when this campaign carries one. */
	sponsor?: { slotId: string; html: string; text: string; hideForTags: string[] };
}

async function linkIds(core: Core, scope: string, urls: string[]): Promise<Map<string, number>> {
	const map = new Map<string, number>();
	if (urls.length === 0) return map;
	await core.db.batch(urls.map((u) => core.db.prepare(`INSERT OR IGNORE INTO nl_links (scope, url) VALUES (?, ?)`).bind(scope, u)));
	const { results } = await core.db.prepare(`SELECT id, url FROM nl_links WHERE scope = ?`).bind(scope).all<{ id: number; url: string }>();
	for (const r of results) map.set(r.url, r.id);
	return map;
}

function fromOf(config: NewsletterConfig, email?: string | null, name?: string | null) {
	return { email: email || config.from.email, name: name || config.from.name || config.publicationName };
}

/** The booked sponsor slot for the day this campaign goes out, if it should carry one. */
async function sponsorFor(core: Core, config: NewsletterConfig, c: Campaign, styles: ReturnType<typeof emailStyles>): Promise<Template["sponsor"]> {
	const sp = config.sponsors;
	if (!sp.enabled) return undefined;
	if (sp.autoIssuesOnly && !c.sourceRef?.startsWith("content:")) return undefined;
	const date = dateInZone(c.scheduledAt ?? c.startedAt ?? now(), config.timezone || "UTC");
	const slot = await sponsorForDate(core, date);
	if (!slot || slot.status !== "booked") return undefined;
	return { slotId: slot.id, ...renderSponsorBlock(slot, config, styles), hideForTags: sp.hideForTags };
}

export async function campaignTemplate(core: Core, config: NewsletterConfig, c: Campaign): Promise<Template> {
	const styles = emailStyles(config.brand.accentColor);
	const body = renderBody(c.contentFormat, c.content, styles, { baseUrl: config.siteUrl });
	const sponsor = await sponsorFor(core, config, c, styles);
	return {
		...(sponsor && { sponsor }),
		subjectA: c.subject,
		subjectB: c.subjectB,
		preheader: c.preheader ?? "",
		html: body.html,
		text: body.text,
		links: c.trackClicks ? await linkIds(core, `c:${c.id}`, collectLinks(body.html + (sponsor?.html ?? ""))) : new Map(),
		from: fromOf(config, c.fromEmail, c.fromName),
		replyTo: c.replyTo || config.replyTo || undefined,
		webUrl: c.publishWeb && c.webSlug ? webIssueUrl(config, c.webSlug) : undefined,
		trackOpens: c.trackOpens && config.trackOpens,
		trackClicks: c.trackClicks && config.trackClicks,
		category: "newsletter",
		referrals: config.referrals.enabled,
		campaignId: c.id,
	};
}

async function automationTemplate(core: Core, config: NewsletterConfig, automationId: string, step: number): Promise<Template | null> {
	const row = await core.db.prepare(`SELECT steps FROM nl_automations WHERE id = ?`).bind(automationId).first<{ steps: string }>();
	const steps = parseJson<{ subject: string; content: string; preheader?: string }[]>(row?.steps, []);
	const s = steps[step];
	if (!s) return null;
	const styles = emailStyles(config.brand.accentColor);
	const body = renderBody("markdown", s.content, styles, { baseUrl: config.siteUrl });
	return {
		subjectA: s.subject,
		subjectB: null,
		preheader: s.preheader ?? "",
		html: body.html,
		text: body.text,
		links: config.trackClicks ? await linkIds(core, `a:${automationId}:${step}`, collectLinks(body.html)) : new Map(),
		from: fromOf(config),
		replyTo: config.replyTo || undefined,
		trackOpens: config.trackOpens,
		trackClicks: config.trackClicks,
		category: "automation",
		referrals: config.referrals.enabled,
		campaignId: null,
	};
}

export function mergeVars(config: NewsletterConfig, s: Subscriber | null, email: string): MergeVars {
	const vars: MergeVars = {
		email,
		first_name: s?.firstName,
		last_name: s?.lastName,
		name: [s?.firstName, s?.lastName].filter(Boolean).join(" "),
		publication: config.publicationName,
		referral_code: s?.referralCode,
	};
	for (const [k, v] of Object.entries(s?.attributes ?? {})) vars[`attr.${k.toLowerCase()}`] = v;
	return vars;
}

/** Renders a template for one recipient into a ready-to-send message. */
export async function personalize(
	core: Core,
	config: NewsletterConfig,
	t: Template,
	row: { id: string; email: string; variant?: string | null },
	s: Subscriber | null,
	referralCount?: number,
	opts: { sponsorHidden?: boolean } = {},
): Promise<OutboundEmail> {
	const unsub = s ? await unsubscribeUrl(core, config, s.id, t.campaignId) : config.siteUrl;
	const prefs = s ? await preferencesUrl(core, config, s.id) : config.siteUrl;
	const vars = mergeVars(config, s, row.email);
	vars.unsubscribe_url = unsub;
	vars.preferences_url = prefs;
	vars.web_url = t.webUrl;
	let referral: Parameters<typeof layout>[0]["referral"];
	if (t.referrals && s) {
		const rUrl = referralUrl(config, s.referralCode);
		vars.referral_url = rUrl;
		const count = referralCount ?? 0;
		vars.referral_count = count;
		const next = config.referrals.milestones.filter((m) => m.count > count).sort((a, b) => a.count - b.count)[0];
		referral = { url: rUrl, count, nextReward: next?.reward, needed: next ? next.count - count : undefined };
	}
	const subject = applyMergeTags(row.variant === "b" && t.subjectB ? t.subjectB : t.subjectA, vars, "text");
	// Subscribers tagged with a hide tag (e.g. paying members) don't see the ad.
	const sponsorHidden = opts.sponsorHidden ?? !!s?.tags?.some((tag) => t.sponsor?.hideForTags.includes(tag));
	const sponsor = t.sponsor && !sponsorHidden ? { html: t.sponsor.html, text: t.sponsor.text } : undefined;
	const done = layout({
		config,
		subject,
		preheader: applyMergeTags(t.preheader, vars, "text"),
		bodyHtml: applyMergeTags(t.html, vars, "html"),
		bodyText: applyMergeTags(t.text, vars, "text"),
		unsubscribeUrl: unsub,
		preferencesUrl: prefs,
		webUrl: t.webUrl,
		sponsor,
		referral,
		reason: `You're receiving this because you subscribed to ${config.publicationName} as ${row.email}.`,
	});
	let html = done.html;
	const mac = await core.signer.mac("track", row.id);
	if (t.trackClicks && t.links.size > 0) {
		const urls = new Map<string, string>();
		for (const [url, id] of t.links) urls.set(url, await clickUrl(core, config, row.id, id, mac));
		html = rewriteLinks(html, (url) => urls.get(url) ?? null);
	}
	if (t.trackOpens) {
		const pixel = await openPixelUrl(core, config, row.id, mac);
		html = html.replace("</body>", `<img src="${pixel}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0"></body>`);
	}
	return {
		from: t.from,
		to: s?.firstName ? { email: row.email, name: [s.firstName, s.lastName].filter(Boolean).join(" ") } : row.email,
		subject,
		html,
		text: done.text,
		...(t.replyTo && { replyTo: t.replyTo }),
		headers: {
			"List-Unsubscribe": `<${unsub}>`,
			"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
			...(t.campaignId && { "X-Newsletter-Campaign": t.campaignId }),
		},
		category: t.category,
		metadata: { nl_outbox_id: row.id, ...(t.campaignId && { nl_campaign_id: t.campaignId }) },
		idempotencyKey: `nl/${row.id}`,
	};
}

// ─────────────────────────────────── drain ───────────────────────────────────

export interface DrainResult {
	sent: number;
	failed: number;
	retried: number;
	skipped: number;
	rateLimited: boolean;
	error?: string;
}

export interface DrainOptions {
	/** Stop after this many messages. */
	maxMessages?: number;
	/** Stop claiming new work after this long (ms). */
	budgetMs?: number;
	/** Only these outbox rows (e.g. a confirmation email being sent right away). */
	ids?: string[];
	/** Override the transport (tests, test sends). */
	transport?: EmailTransport;
}

export async function drain(core: Core, opts: DrainOptions = {}): Promise<DrainResult> {
	const result: DrainResult = { sent: 0, failed: 0, retried: 0, skipped: 0, rateLimited: false };
	const started = now();
	const config = await core.settings.get();
	let transport: EmailTransport;
	try {
		transport = opts.transport ?? (await core.transport(config));
	} catch (err) {
		result.error = (err as Error).message;
		return result;
	}
	if (!opts.ids) await recoverStale(core);
	const maxMessages = opts.maxMessages ?? 5000;
	const budget = opts.budgetMs ?? 25_000;
	const templates = new Map<string, Template | null>();
	const chunk = Math.max(1, Math.min(transport.maxBatch, 100));

	while (result.sent + result.failed + result.retried + result.skipped < maxMessages && now() - started < budget) {
		const want = Math.min(chunk * 4, maxMessages - (result.sent + result.failed + result.retried + result.skipped));
		const granted = await reserveRate(core, Math.max(1, config.sendRatePerMinute), want);
		if (granted === 0) {
			result.rateLimited = true;
			break;
		}
		const rows = await claim(core, granted, opts.ids);
		await releaseRate(core, granted - rows.length);
		if (rows.length === 0) break;

		// Load recipients and referral counts in bulk.
		const subIds = [...new Set(rows.map((r) => r.subscriber_id).filter((x): x is string => !!x))];
		const subs = new Map<string, Subscriber>();
		const refCounts = new Map<string, number>();
		if (subIds.length) {
			const ph = subIds.map(() => "?").join(",");
			const { results } = await core.db.prepare(`SELECT * FROM nl_subscribers WHERE id IN (${ph})`).bind(...subIds).all();
			for (const r of results) subs.set(r.id as string, mapSubscriber(r));
			if (config.referrals.enabled) {
				const rc = await core.db
					.prepare(`SELECT referred_by AS id, COUNT(*) AS n FROM nl_subscribers WHERE status = 'active' AND referred_by IN (${ph}) GROUP BY referred_by`)
					.bind(...subIds)
					.all<{ id: string; n: number }>();
				for (const r of rc.results) refCounts.set(r.id, r.n);
			}
		}
		// Who in this chunk carries a tag that hides sponsor ads.
		const noAds = new Set<string>();
		const hideTags = config.sponsors.enabled ? config.sponsors.hideForTags : [];
		if (subIds.length && hideTags.length) {
			const { results } = await core.db
				.prepare(
					`SELECT DISTINCT subscriber_id FROM nl_tags WHERE tag IN (${hideTags.map(() => "?").join(",")}) AND subscriber_id IN (${subIds.map(() => "?").join(",")})`,
				)
				.bind(...hideTags, ...subIds)
				.all<{ subscriber_id: string }>();
			for (const r of results) noAds.add(r.subscriber_id);
		}
		const suppressed = new Set(
			(
				await core.db
					.prepare(`SELECT email FROM nl_suppressions WHERE email IN (${rows.map(() => "?").join(",")})`)
					.bind(...rows.map((r) => r.email))
					.all<{ email: string }>()
			).results.map((r) => r.email),
		);

		const ready: { row: OutboxRow; msg: OutboundEmail }[] = [];
		const updates: ReturnType<Core["db"]["prepare"]>[] = [];
		const skip = (row: OutboxRow, why: string) => {
			result.skipped++;
			updates.push(core.db.prepare(`UPDATE nl_outbox SET status = 'skipped', error = ?, locked_until = NULL WHERE id = ?`).bind(why, row.id));
		};

		for (const row of rows) {
			try {
				if (row.kind === "transactional") {
					const p = parseJson<TransactionalPayload | null>(row.payload, null);
					if (!p) {
						skip(row, "missing payload");
						continue;
					}
					// Confirmations go to pending/suppressed addresses on purpose, except hard bounces.
					const sub = row.subscriber_id ? subs.get(row.subscriber_id) : undefined;
					if (sub?.status === "bounced" || sub?.status === "complained") {
						skip(row, `subscriber ${sub.status}`);
						continue;
					}
					ready.push({
						row,
						msg: {
							from: fromOf(config),
							to: row.email,
							subject: p.subject,
							html: p.html,
							text: p.text,
							...(config.replyTo && { replyTo: config.replyTo }),
							...(p.headers && { headers: p.headers }),
							category: p.category ?? "transactional",
							metadata: { nl_outbox_id: row.id },
							idempotencyKey: `nl/${row.id}`,
						},
					});
					continue;
				}
				const sub = row.subscriber_id ? subs.get(row.subscriber_id) : undefined;
				if (!sub || sub.status !== "active") {
					skip(row, `subscriber ${sub?.status ?? "deleted"}`);
					continue;
				}
				if (suppressed.has(row.email)) {
					skip(row, "suppressed");
					continue;
				}
				const key = row.kind === "campaign" ? `c:${row.campaign_id}` : `a:${row.automation_id}:${row.step}`;
				if (!templates.has(key)) {
					if (row.kind === "campaign") {
						const c = row.campaign_id ? await getCampaign(core, row.campaign_id) : null;
						const t = c && c.status !== "canceled" ? await campaignTemplate(core, config, c) : null;
						if (t?.sponsor && c) await markSponsorSent(core, t.sponsor.slotId, c.id);
						templates.set(key, t);
					} else {
						templates.set(key, row.automation_id ? await automationTemplate(core, config, row.automation_id, row.step ?? 0) : null);
					}
				}
				const t = templates.get(key);
				if (!t) {
					skip(row, "campaign or automation step no longer exists");
					continue;
				}
				ready.push({ row, msg: await personalize(core, config, t, row, sub, refCounts.get(sub.id), { sponsorHidden: noAds.has(sub.id) }) });
			} catch (err) {
				skip(row, `render failed: ${(err as Error).message}`.slice(0, 500));
			}
		}

		for (let i = 0; i < ready.length; i += chunk) {
			const part = ready.slice(i, i + chunk);
			const results = await transport.sendBatch(part.map((p) => p.msg));
			part.forEach(({ row }, j) => {
				const r = results[j];
				if (r?.ok) {
					result.sent++;
					updates.push(
						core.db
							.prepare(`UPDATE nl_outbox SET status = 'sent', sent_at = ?, provider = ?, provider_message_id = ?, error = NULL, locked_until = NULL WHERE id = ?`)
							.bind(now(), transport.name, r.messageId ?? null, row.id),
					);
					return;
				}
				const e = (r && !r.ok ? r.error : undefined) as EmailSendError | undefined;
				const msg = (e?.message ?? "unknown send error").slice(0, 500);
				if (e?.retryable && row.attempts < MAX_ATTEMPTS) {
					result.retried++;
					updates.push(
						core.db
							.prepare(`UPDATE nl_outbox SET status = 'queued', next_attempt_at = ?, error = ?, provider = ?, locked_until = NULL WHERE id = ?`)
							.bind(now() + BACKOFF_MS[Math.min(row.attempts - 1, BACKOFF_MS.length - 1)], msg, transport.name, row.id),
					);
				} else {
					result.failed++;
					updates.push(
						core.db.prepare(`UPDATE nl_outbox SET status = 'failed', error = ?, provider = ?, locked_until = NULL WHERE id = ?`).bind(msg, transport.name, row.id),
					);
					if (e?.permanentRecipient && row.subscriber_id) {
						updates.push(
							core.db.prepare(`UPDATE nl_subscribers SET status = 'bounced', updated_at = ? WHERE id = ? AND status IN ('active','pending')`).bind(now(), row.subscriber_id),
							core.db.prepare(`INSERT OR IGNORE INTO nl_suppressions (email, reason, created_at) VALUES (?, 'hard_bounce', ?)`).bind(row.email, now()),
						);
					}
				}
			});
		}
		for (let i = 0; i < updates.length; i += 50) await core.db.batch(updates.slice(i, i + 50));
		if (opts.ids) break;
	}
	return result;
}

/** Cancels queued rows of a campaign (e.g. when it's canceled mid-send). */
export async function cancelQueued(core: Core, campaignId: string): Promise<number> {
	return changes(
		await core.db.prepare(`UPDATE nl_outbox SET status = 'canceled' WHERE campaign_id = ? AND status = 'queued'`).bind(campaignId).run(),
	);
}

export async function queueDepth(core: Core): Promise<{ queued: number; sending: number; failed24h: number }> {
	const r = await core.db
		.prepare(
			`SELECT
			   SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
			   SUM(CASE WHEN status = 'sending' THEN 1 ELSE 0 END) AS sending,
			   SUM(CASE WHEN status = 'failed' AND created_at > ? THEN 1 ELSE 0 END) AS failed24h
			 FROM nl_outbox WHERE status IN ('queued','sending','failed')`,
		)
		.bind(now() - 86400_000)
		.first<{ queued: number | null; sending: number | null; failed24h: number | null }>();
	return { queued: r?.queued ?? 0, sending: r?.sending ?? 0, failed24h: r?.failed24h ?? 0 };
}
