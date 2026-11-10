/** Reporting: list growth, campaign performance and link clicks. */
import type { Core } from "./core.ts";
import { variantResults } from "./campaigns.ts";
import { queueDepth } from "./sender.ts";
import { now } from "./util.ts";

const DAY = 86400_000;

export interface Overview {
	subscribers: { total: number; active: number; pending: number; unsubscribed: number; bounced: number; complained: number };
	last30: { newActive: number; unsubscribed: number; sent: number; uniqueOpens: number; uniqueClicks: number; openRate: number; clickRate: number };
	growth: [number, number][];
	queue: { queued: number; sending: number; failed24h: number };
}

export async function overview(core: Core): Promise<Overview> {
	const since = now() - 30 * DAY;
	const counts = await core.db.prepare(`SELECT status, COUNT(*) AS n FROM nl_subscribers GROUP BY status`).all<{ status: string; n: number }>();
	const subs = { total: 0, active: 0, pending: 0, unsubscribed: 0, bounced: 0, complained: 0 };
	for (const r of counts.results) {
		subs.total += r.n;
		if (r.status in subs) (subs as Record<string, number>)[r.status] = r.n;
	}
	const ev = await core.db
		.prepare(
			`SELECT
			   (SELECT COUNT(DISTINCT subscriber_id) FROM nl_events WHERE type = 'subscribed' AND created_at >= ?1) AS new_active,
			   (SELECT COUNT(DISTINCT subscriber_id) FROM nl_events WHERE type = 'unsubscribed' AND created_at >= ?1) AS unsubs,
			   (SELECT COUNT(*) FROM nl_outbox WHERE status = 'sent' AND kind <> 'transactional' AND sent_at >= ?1) AS sent,
			   (SELECT COUNT(DISTINCT outbox_id) FROM nl_events WHERE type = 'open' AND created_at >= ?1) AS opens,
			   (SELECT COUNT(DISTINCT outbox_id) FROM nl_events WHERE type = 'click' AND created_at >= ?1) AS clicks`,
		)
		.bind(since)
		.first<{ new_active: number; unsubs: number; sent: number; opens: number; clicks: number }>();
	const growthRows = await core.db
		.prepare(
			`SELECT CAST(created_at / ${DAY} AS INTEGER) AS day, COUNT(DISTINCT subscriber_id) AS n FROM nl_events
			 WHERE type = 'subscribed' AND created_at >= ? GROUP BY day ORDER BY day`,
		)
		.bind(since)
		.all<{ day: number; n: number }>();
	const byDay = new Map(growthRows.results.map((r) => [r.day, r.n]));
	const firstDay = Math.floor(since / DAY);
	const growth: [number, number][] = [];
	for (let d = firstDay; d <= Math.floor(now() / DAY); d++) growth.push([d * DAY, byDay.get(d) ?? 0]);
	const sent = ev?.sent ?? 0;
	return {
		subscribers: subs,
		last30: {
			newActive: ev?.new_active ?? 0,
			unsubscribed: ev?.unsubs ?? 0,
			sent,
			uniqueOpens: ev?.opens ?? 0,
			uniqueClicks: ev?.clicks ?? 0,
			openRate: sent ? (ev?.opens ?? 0) / sent : 0,
			clickRate: sent ? (ev?.clicks ?? 0) / sent : 0,
		},
		growth,
		queue: await queueDepth(core),
	};
}

export interface CampaignStats {
	recipients: number;
	queued: number;
	sent: number;
	failed: number;
	skipped: number;
	delivered: number;
	bounced: number;
	complained: number;
	unsubscribed: number;
	uniqueOpens: number;
	uniqueClicks: number;
	totalClicks: number;
	openRate: number;
	clickRate: number;
	clickToOpen: number;
	links: { url: string; clicks: number; unique: number }[];
	variants: Record<string, { sent: number; opens: number; clicks: number }>;
	timeline: [number, number][];
}

export async function campaignStats(core: Core, id: string): Promise<CampaignStats> {
	const ob = await core.db.prepare(`SELECT status, COUNT(*) AS n FROM nl_outbox WHERE campaign_id = ? GROUP BY status`).bind(id).all<{ status: string; n: number }>();
	const o: Record<string, number> = {};
	for (const r of ob.results) o[r.status] = r.n;
	const ev = await core.db
		.prepare(
			`SELECT type, COUNT(*) AS total, COUNT(DISTINCT COALESCE(subscriber_id, outbox_id)) AS uniq FROM nl_events WHERE campaign_id = ? GROUP BY type`,
		)
		.bind(id)
		.all<{ type: string; total: number; uniq: number }>();
	const e: Record<string, { total: number; uniq: number }> = {};
	for (const r of ev.results) e[r.type] = r;
	const links = await core.db
		.prepare(
			`SELECT l.url, COUNT(*) AS clicks, COUNT(DISTINCT e.outbox_id) AS uniq FROM nl_events e JOIN nl_links l ON l.id = e.link_id
			 WHERE e.campaign_id = ? AND e.type = 'click' GROUP BY l.url ORDER BY clicks DESC LIMIT 25`,
		)
		.bind(id)
		.all<{ url: string; clicks: number; uniq: number }>();
	const tl = await core.db
		.prepare(
			`SELECT CAST(created_at / 3600000 AS INTEGER) AS h, COUNT(DISTINCT outbox_id) AS n FROM nl_events
			 WHERE campaign_id = ? AND type = 'open' GROUP BY h ORDER BY h LIMIT 168`,
		)
		.bind(id)
		.all<{ h: number; n: number }>();
	const sent = o.sent ?? 0;
	const opens = e.open?.uniq ?? 0;
	const clicks = e.click?.uniq ?? 0;
	return {
		recipients: Object.values(o).reduce((a, b) => a + b, 0) - (o.canceled ?? 0),
		queued: (o.queued ?? 0) + (o.sending ?? 0),
		sent,
		failed: o.failed ?? 0,
		skipped: o.skipped ?? 0,
		delivered: e.delivered?.uniq ?? 0,
		bounced: e.bounced?.uniq ?? 0,
		complained: e.complained?.uniq ?? 0,
		unsubscribed: e.unsubscribed?.uniq ?? 0,
		uniqueOpens: opens,
		uniqueClicks: clicks,
		totalClicks: e.click?.total ?? 0,
		openRate: sent ? opens / sent : 0,
		clickRate: sent ? clicks / sent : 0,
		clickToOpen: opens ? clicks / opens : 0,
		links: links.results.map((l) => ({ url: l.url, clicks: l.clicks, unique: l.uniq })),
		variants: await variantResults(core, id),
		timeline: tl.results.map((r) => [r.h * 3600_000, r.n]),
	};
}

export const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
