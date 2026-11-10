/**
 * Campaigns (issues): compose, schedule, A/B test subject lines, send, cancel.
 *
 * Lifecycle: draft → scheduled → (testing →) sending → sent, or canceled/failed.
 * Sending fans the audience out into nl_outbox in one INSERT…SELECT; the
 * sender drains it. Each subscriber gets at most one row per campaign.
 */
import type { Core } from "./core.ts";
import { changes } from "./db.ts";
import type { ContentFormat } from "./render/email.ts";
import { type Audience, audienceWhere, countAudience, type SegmentRules } from "./segments.ts";
import { campaignTemplate, cancelQueued, personalize } from "./sender.ts";
import { configProblems } from "./settings.ts";
import { getSubscriberByEmail } from "./subscribers.ts";
import { newId, normalizeEmail, now, parseJson, randomCode, slugify } from "./util.ts";

export type CampaignStatus = "draft" | "scheduled" | "testing" | "sending" | "sent" | "canceled" | "failed";

export interface Campaign {
	id: string;
	name: string;
	subject: string;
	subjectB: string | null;
	preheader: string | null;
	fromName: string | null;
	fromEmail: string | null;
	replyTo: string | null;
	contentFormat: ContentFormat;
	content: string;
	segmentId: string | null;
	audience: { topic?: string | null; rules?: SegmentRules | null };
	status: CampaignStatus;
	scheduledAt: number | null;
	startedAt: number | null;
	sentAt: number | null;
	abTestPct: number;
	abWaitMinutes: number;
	abMetric: "clicks" | "opens";
	abWinner: string | null;
	abDecideAt: number | null;
	sourceRef: string | null;
	webSlug: string | null;
	publishWeb: boolean;
	webAccess: "public" | "members";
	trackOpens: boolean;
	trackClicks: boolean;
	recipientsTotal: number;
	error: string | null;
	createdAt: number;
	updatedAt: number;
}

export type CampaignInput = Partial<
	Pick<
		Campaign,
		| "name"
		| "subject"
		| "subjectB"
		| "preheader"
		| "fromName"
		| "fromEmail"
		| "replyTo"
		| "contentFormat"
		| "content"
		| "segmentId"
		| "audience"
		| "abTestPct"
		| "abWaitMinutes"
		| "abMetric"
		| "publishWeb"
		| "webAccess"
		| "trackOpens"
		| "trackClicks"
		| "sourceRef"
		| "webSlug"
	>
>;

function map(r: Record<string, unknown>): Campaign {
	return {
		id: r.id as string,
		name: r.name as string,
		subject: r.subject as string,
		subjectB: (r.subject_b as string) || null,
		preheader: (r.preheader as string) ?? null,
		fromName: (r.from_name as string) || null,
		fromEmail: (r.from_email as string) || null,
		replyTo: (r.reply_to as string) || null,
		contentFormat: (r.content_format as ContentFormat) ?? "markdown",
		content: (r.content as string) ?? "",
		segmentId: (r.segment_id as string) || null,
		audience: parseJson(r.audience, {}),
		status: r.status as CampaignStatus,
		scheduledAt: (r.scheduled_at as number) ?? null,
		startedAt: (r.started_at as number) ?? null,
		sentAt: (r.sent_at as number) ?? null,
		abTestPct: (r.ab_test_pct as number) ?? 0,
		abWaitMinutes: (r.ab_wait_minutes as number) ?? 240,
		abMetric: r.ab_metric === "opens" ? "opens" : "clicks",
		abWinner: (r.ab_winner as string) ?? null,
		abDecideAt: (r.ab_decide_at as number) ?? null,
		sourceRef: (r.source_ref as string) ?? null,
		webSlug: (r.web_slug as string) ?? null,
		publishWeb: !!r.publish_web,
		webAccess: r.web_access === "members" ? "members" : "public",
		trackOpens: !!r.track_opens,
		trackClicks: !!r.track_clicks,
		recipientsTotal: (r.recipients_total as number) ?? 0,
		error: (r.error as string) ?? null,
		createdAt: r.created_at as number,
		updatedAt: r.updated_at as number,
	};
}

export function campaignAudience(c: Pick<Campaign, "segmentId" | "audience">): Audience {
	return { segmentId: c.segmentId, topic: c.audience?.topic ?? null, rules: c.audience?.rules ?? null };
}

export async function getCampaign(core: Core, id: string): Promise<Campaign | null> {
	const r = await core.db.prepare(`SELECT * FROM nl_campaigns WHERE id = ?`).bind(id).first();
	return r ? map(r) : null;
}

export async function getCampaignBySlug(core: Core, slug: string): Promise<Campaign | null> {
	const r = await core.db.prepare(`SELECT * FROM nl_campaigns WHERE web_slug = ?`).bind(slug).first();
	return r ? map(r) : null;
}

export async function getCampaignBySource(core: Core, sourceRef: string): Promise<Campaign | null> {
	const r = await core.db.prepare(`SELECT * FROM nl_campaigns WHERE source_ref = ?`).bind(sourceRef).first();
	return r ? map(r) : null;
}

export async function listCampaigns(core: Core, opts: { status?: CampaignStatus | ""; limit?: number; offset?: number } = {}): Promise<Campaign[]> {
	const { results } = await core.db
		.prepare(
			`SELECT * FROM nl_campaigns ${opts.status ? "WHERE status = ?" : ""}
			 ORDER BY CASE WHEN status IN ('draft','scheduled') THEN 0 ELSE 1 END, COALESCE(sent_at, scheduled_at, updated_at) DESC LIMIT ? OFFSET ?`,
		)
		.bind(...(opts.status ? [opts.status] : []), Math.min(opts.limit ?? 50, 200), opts.offset ?? 0)
		.all();
	return results.map(map);
}

/** Published web-archive issues, newest first. */
export async function listArchive(core: Core, limit = 30, offset = 0): Promise<Campaign[]> {
	const { results } = await core.db
		.prepare(`SELECT * FROM nl_campaigns WHERE publish_web = 1 AND status IN ('sending','sent') AND web_slug IS NOT NULL ORDER BY COALESCE(sent_at, started_at) DESC LIMIT ? OFFSET ?`)
		.bind(limit, offset)
		.all();
	return results.map(map);
}

async function uniqueSlug(core: Core, base: string, exceptId?: string): Promise<string> {
	let slug = slugify(base);
	for (let i = 0; i < 5; i++) {
		const hit = await core.db.prepare(`SELECT id FROM nl_campaigns WHERE web_slug = ?`).bind(slug).first<{ id: string }>();
		if (!hit || hit.id === exceptId) return slug;
		slug = `${slugify(base).slice(0, 70)}-${randomCode(4)}`;
	}
	return `${slugify(base).slice(0, 60)}-${randomCode(8)}`;
}

function clampInput(i: CampaignInput) {
	return {
		...i,
		abTestPct: i.abTestPct === undefined ? undefined : Math.max(0, Math.min(50, Math.round(Number(i.abTestPct) || 0))),
		abWaitMinutes: i.abWaitMinutes === undefined ? undefined : Math.max(15, Math.min(48 * 60, Math.round(Number(i.abWaitMinutes) || 240))),
	};
}

export async function createCampaign(core: Core, input: CampaignInput & { subject: string }): Promise<Campaign> {
	const id = newId("cmp_");
	const i = { ...clampInput(input), subject: input.subject };
	const t = now();
	const name = (i.name || i.subject).slice(0, 200);
	const slug = await uniqueSlug(core, i.webSlug || i.subject);
	await core.db
		.prepare(
			`INSERT INTO nl_campaigns (id, name, subject, subject_b, preheader, from_name, from_email, reply_to, content_format, content,
			   segment_id, audience, status, ab_test_pct, ab_wait_minutes, ab_metric, source_ref, web_slug, publish_web, web_access,
			   track_opens, track_clicks, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			id,
			name,
			i.subject.slice(0, 300),
			i.subjectB?.slice(0, 300) || null,
			i.preheader?.slice(0, 300) ?? null,
			i.fromName || null,
			normalizeEmail(i.fromEmail) ?? null,
			normalizeEmail(i.replyTo) ?? null,
			i.contentFormat ?? "markdown",
			i.content ?? "",
			i.segmentId || null,
			JSON.stringify(i.audience ?? {}),
			i.abTestPct ?? 0,
			i.abWaitMinutes ?? 240,
			i.abMetric === "opens" ? "opens" : "clicks",
			i.sourceRef ?? null,
			slug,
			i.publishWeb === false ? 0 : 1,
			i.webAccess === "members" ? "members" : "public",
			i.trackOpens === false ? 0 : 1,
			i.trackClicks === false ? 0 : 1,
			t,
			t,
		)
		.run();
	return (await getCampaign(core, id))!;
}

export async function updateCampaign(core: Core, id: string, patch: CampaignInput): Promise<Campaign> {
	const cur = await getCampaign(core, id);
	if (!cur) throw new Error("Campaign not found");
	if (!["draft", "scheduled"].includes(cur.status)) throw new Error(`A ${cur.status} campaign can't be edited`);
	const n = { ...cur } as Campaign;
	const clamped = clampInput(patch) as Record<string, unknown>;
	for (const k of Object.keys(patch)) if (clamped[k] !== undefined) (n as unknown as Record<string, unknown>)[k] = clamped[k];
	const slug = patch.webSlug !== undefined ? await uniqueSlug(core, patch.webSlug || n.subject, id) : cur.webSlug;
	await core.db
		.prepare(
			`UPDATE nl_campaigns SET name = ?, subject = ?, subject_b = ?, preheader = ?, from_name = ?, from_email = ?, reply_to = ?,
			   content_format = ?, content = ?, segment_id = ?, audience = ?, ab_test_pct = ?, ab_wait_minutes = ?, ab_metric = ?,
			   web_slug = ?, publish_web = ?, web_access = ?, track_opens = ?, track_clicks = ?, updated_at = ? WHERE id = ?`,
		)
		.bind(
			(n.name || n.subject).slice(0, 200),
			n.subject.slice(0, 300),
			n.subjectB?.slice(0, 300) || null,
			n.preheader?.slice(0, 300) ?? null,
			n.fromName || null,
			normalizeEmail(n.fromEmail) ?? null,
			normalizeEmail(n.replyTo) ?? null,
			n.contentFormat,
			n.content,
			n.segmentId || null,
			JSON.stringify(n.audience ?? {}),
			n.abTestPct,
			n.abWaitMinutes,
			n.abMetric,
			slug,
			n.publishWeb ? 1 : 0,
			n.webAccess,
			n.trackOpens ? 1 : 0,
			n.trackClicks ? 1 : 0,
			now(),
			id,
		)
		.run();
	return (await getCampaign(core, id))!;
}

export async function duplicateCampaign(core: Core, id: string): Promise<Campaign> {
	const c = await getCampaign(core, id);
	if (!c) throw new Error("Campaign not found");
	const { sourceRef: _s, webSlug: _w, ...rest } = c;
	return createCampaign(core, { ...rest, name: `${c.name} (copy)` });
}

export async function deleteCampaign(core: Core, id: string): Promise<void> {
	const c = await getCampaign(core, id);
	if (!c) return;
	if (c.status === "sending" || c.status === "testing") throw new Error("Cancel the campaign before deleting it");
	await core.db.batch([
		core.db.prepare(`DELETE FROM nl_outbox WHERE campaign_id = ? AND status IN ('queued','canceled','skipped')`).bind(id),
		core.db.prepare(`DELETE FROM nl_campaigns WHERE id = ?`).bind(id),
	]);
}

export async function scheduleCampaign(core: Core, id: string, at: number): Promise<Campaign> {
	const c = await getCampaign(core, id);
	if (!c) throw new Error("Campaign not found");
	if (!["draft", "scheduled"].includes(c.status)) throw new Error(`A ${c.status} campaign can't be scheduled`);
	if (!Number.isFinite(at)) throw new Error("Invalid schedule time");
	await assertSendable(core, c);
	await core.db.prepare(`UPDATE nl_campaigns SET status = 'scheduled', scheduled_at = ?, updated_at = ? WHERE id = ?`).bind(at, now(), id).run();
	return (await getCampaign(core, id))!;
}

export async function unscheduleCampaign(core: Core, id: string): Promise<Campaign> {
	await core.db.prepare(`UPDATE nl_campaigns SET status = 'draft', scheduled_at = NULL, updated_at = ? WHERE id = ? AND status = 'scheduled'`).bind(now(), id).run();
	return (await getCampaign(core, id))!;
}

async function assertSendable(core: Core, c: Campaign) {
	const problems = configProblems(await core.settings.get());
	if (problems.length) throw new Error(problems.join(" "));
	if (!c.subject.trim()) throw new Error("Add a subject line");
	if (!c.content.trim()) throw new Error("Add some content");
}

async function enqueue(core: Core, c: Campaign, opts: { variant: string; limit?: number; random?: boolean }): Promise<number> {
	const { where, binds } = await audienceWhere(core, campaignAudience(c));
	const variant = opts.variant === "split" ? `CASE WHEN abs(random()) % 2 = 0 THEN 'a' ELSE 'b' END` : `'${opts.variant === "b" ? "b" : "a"}'`;
	const res = await core.db
		.prepare(
			`INSERT OR IGNORE INTO nl_outbox (id, kind, campaign_id, subscriber_id, email, variant, priority, next_attempt_at, created_at)
			 SELECT 'ob_' || lower(hex(randomblob(12))), 'campaign', ?, s.id, s.email, ${variant}, 5, ?, ?
			 FROM nl_subscribers s WHERE ${where}
			 ${opts.random ? "ORDER BY random()" : ""} ${opts.limit !== undefined ? "LIMIT ?" : ""}`,
		)
		.bind(c.id, now(), now(), ...binds, ...(opts.limit !== undefined ? [opts.limit] : []))
		.run();
	return changes(res);
}

/** Starts sending now: fans the audience out to the outbox (or the A/B test group first). */
export async function startCampaign(core: Core, id: string): Promise<Campaign> {
	const c = await getCampaign(core, id);
	if (!c) throw new Error("Campaign not found");
	if (!["draft", "scheduled"].includes(c.status)) throw new Error(`A ${c.status} campaign can't be sent`);
	await assertSendable(core, c);
	// Claim the campaign so two ticks can't both start it.
	const claimed = await core.db
		.prepare(`UPDATE nl_campaigns SET status = 'sending', started_at = ?, updated_at = ? WHERE id = ? AND status IN ('draft','scheduled')`)
		.bind(now(), now(), id)
		.run();
	if (changes(claimed) === 0) return (await getCampaign(core, id))!;
	try {
		const total = await countAudience(core, campaignAudience(c));
		const abTest = c.abTestPct > 0 && !!c.subjectB && total >= 20;
		if (abTest) {
			const testSize = Math.max(10, Math.ceil((total * c.abTestPct * 2) / 100));
			const queued = await enqueue(core, c, { variant: "split", limit: Math.min(testSize, total), random: true });
			await core.db
				.prepare(`UPDATE nl_campaigns SET status = 'testing', ab_decide_at = ?, recipients_total = ?, updated_at = ? WHERE id = ?`)
				.bind(now() + c.abWaitMinutes * 60_000, queued, now(), id)
				.run();
		} else {
			const queued = await enqueue(core, c, { variant: "a" });
			await core.db.prepare(`UPDATE nl_campaigns SET recipients_total = ?, updated_at = ? WHERE id = ?`).bind(queued, now(), id).run();
		}
	} catch (err) {
		await core.db
			.prepare(`UPDATE nl_campaigns SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`)
			.bind(String((err as Error).message).slice(0, 500), now(), id)
			.run();
		throw err;
	}
	core.log.info("campaign started", { id });
	return (await getCampaign(core, id))!;
}

export async function cancelCampaign(core: Core, id: string): Promise<Campaign> {
	const c = await getCampaign(core, id);
	if (!c) throw new Error("Campaign not found");
	if (["sent", "canceled"].includes(c.status)) return c;
	await cancelQueued(core, id);
	await core.db.prepare(`UPDATE nl_campaigns SET status = 'canceled', updated_at = ? WHERE id = ?`).bind(now(), id).run();
	return (await getCampaign(core, id))!;
}

/** Variant results so far: sent, unique opens, unique clicks per variant. */
export async function variantResults(core: Core, id: string): Promise<Record<string, { sent: number; opens: number; clicks: number }>> {
	const out: Record<string, { sent: number; opens: number; clicks: number }> = { a: { sent: 0, opens: 0, clicks: 0 }, b: { sent: 0, opens: 0, clicks: 0 } };
	const sent = await core.db
		.prepare(`SELECT variant, COUNT(*) AS n FROM nl_outbox WHERE campaign_id = ? AND status = 'sent' GROUP BY variant`)
		.bind(id)
		.all<{ variant: string; n: number }>();
	for (const r of sent.results) if (out[r.variant]) out[r.variant].sent = r.n;
	const ev = await core.db
		.prepare(`SELECT variant, type, COUNT(DISTINCT outbox_id) AS n FROM nl_events WHERE campaign_id = ? AND type IN ('open','click') GROUP BY variant, type`)
		.bind(id)
		.all<{ variant: string; type: string; n: number }>();
	for (const r of ev.results) {
		if (!out[r.variant]) continue;
		if (r.type === "open") out[r.variant].opens = r.n;
		else out[r.variant].clicks = r.n;
	}
	return out;
}

/** Scheduler work: start due campaigns, decide A/B winners, mark finished sends. */
export async function tickCampaigns(core: Core): Promise<{ started: string[]; decided: string[]; finished: string[] }> {
	const out = { started: [] as string[], decided: [] as string[], finished: [] as string[] };
	const due = await core.db
		.prepare(`SELECT id FROM nl_campaigns WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 10`)
		.bind(now())
		.all<{ id: string }>();
	for (const { id } of due.results) {
		try {
			await startCampaign(core, id);
			out.started.push(id);
		} catch (err) {
			core.log.error("scheduled campaign failed to start", { id, error: (err as Error).message });
		}
	}

	const testing = await core.db.prepare(`SELECT * FROM nl_campaigns WHERE status = 'testing' AND ab_decide_at <= ?`).bind(now()).all();
	for (const row of testing.results) {
		const c = map(row);
		const r = await variantResults(core, c.id);
		const rate = (v: { sent: number; opens: number; clicks: number }) => (v.sent ? (c.abMetric === "opens" ? v.opens : v.clicks) / v.sent : 0);
		// Ties go to A. If clicks are all zero, fall back to opens.
		let winner = rate(r.b) > rate(r.a) ? "b" : "a";
		if (c.abMetric === "clicks" && r.a.clicks + r.b.clicks === 0) winner = (r.b.sent ? r.b.opens / r.b.sent : 0) > (r.a.sent ? r.a.opens / r.a.sent : 0) ? "b" : "a";
		const moved = await core.db
			.prepare(`UPDATE nl_campaigns SET status = 'sending', ab_winner = ?, updated_at = ? WHERE id = ? AND status = 'testing'`)
			.bind(winner, now(), c.id)
			.run();
		if (changes(moved) === 0) continue;
		const queued = await enqueue(core, c, { variant: winner });
		await core.db.prepare(`UPDATE nl_campaigns SET recipients_total = recipients_total + ? WHERE id = ?`).bind(queued, c.id).run();
		out.decided.push(c.id);
	}

	const sending = await core.db
		.prepare(
			`SELECT c.id FROM nl_campaigns c WHERE c.status = 'sending'
			 AND NOT EXISTS (SELECT 1 FROM nl_outbox o WHERE o.campaign_id = c.id AND o.status IN ('queued','sending'))`,
		)
		.all<{ id: string }>();
	for (const { id } of sending.results) {
		await core.db
			.prepare(
				`UPDATE nl_campaigns SET status = 'sent', sent_at = ?, recipients_total = (SELECT COUNT(*) FROM nl_outbox WHERE campaign_id = ? AND status = 'sent'), updated_at = ? WHERE id = ? AND status = 'sending'`,
			)
			.bind(now(), id, now(), id)
			.run();
		out.finished.push(id);
	}
	return out;
}

/** Renders the campaign for one address (real subscriber data when they exist). */
export async function renderCampaignFor(core: Core, id: string, email: string, variant: "a" | "b" = "a") {
	const c = await getCampaign(core, id);
	if (!c) throw new Error("Campaign not found");
	const config = await core.settings.get();
	const t = await campaignTemplate(core, config, { ...c, trackClicks: false, trackOpens: false });
	const sub = await getSubscriberByEmail(core, email, true);
	return personalize(core, config, t, { id: `preview_${c.id}`, email, variant }, sub, 0);
}

/** Sends a test to up to 10 addresses directly (not through the outbox, no tracking). */
export async function sendTest(core: Core, id: string, emails: string[]): Promise<{ sent: string[]; errors: string[] }> {
	const list = [...new Set(emails.map(normalizeEmail).filter((e): e is string => !!e))].slice(0, 10);
	if (!list.length) throw new Error("Enter at least one valid email address");
	const config = await core.settings.get();
	const transport = await core.transport(config);
	const c = await getCampaign(core, id);
	const out = { sent: [] as string[], errors: [] as string[] };
	for (const email of list) {
		for (const variant of c?.subjectB && c.abTestPct > 0 ? (["a", "b"] as const) : (["a"] as const)) {
			const msg = await renderCampaignFor(core, id, email, variant);
			msg.subject = `[Test${variant === "b" ? " B" : ""}] ${msg.subject}`;
			msg.category = "test";
			delete msg.idempotencyKey;
			try {
				await transport.send(msg);
				out.sent.push(email);
			} catch (err) {
				out.errors.push(`${email}: ${(err as Error).message}`);
			}
		}
	}
	return out;
}
