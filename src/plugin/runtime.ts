/**
 * EmDash native plugin runtime (loaded in the Worker via the descriptor's
 * `entrypoint`). Wires the newsletter engine into EmDash: Block Kit admin,
 * a per-minute cron for sending, publish → email, and MCP tools for agents.
 */
import { definePlugin } from "emdash";
import { z } from "zod";
import { handleAdmin } from "./admin.ts";
import { ADMIN_PAGES, PLUGIN_ID, PLUGIN_VERSION } from "./index.ts";
import type { PluginOptions } from "./options.ts";
import { adoptSiteDefaults, getNewsletter, setPluginOptions } from "./shared.ts";

export { adoptSiteDefaults, configureNewsletter, getNewsletter, setNewsletterHooks } from "./shared.ts";

const TICK = "newsletter-tick";

const campaignCreateInput = z.object({
	subject: z.string().min(1).max(300).describe("Subject line"),
	content: z.string().min(1).describe("Body in Markdown. Merge tags like {{first_name|there}} and buttons [[Label]](https://url) are supported."),
	preheader: z.string().max(300).optional().describe("Preview text shown after the subject"),
	segmentId: z.string().optional().describe("Segment id; omit to send to all active subscribers"),
	topic: z.string().optional().describe("Topic slug to restrict the audience"),
	subjectB: z.string().max(300).optional().describe("Alternative subject for an A/B test"),
	abTestPct: z.number().int().min(0).max(50).optional().describe("Percent of the audience per variant in the A/B test"),
});
const idInput = z.object({ campaignId: z.string().min(1) });
const testInput = z.object({ campaignId: z.string().min(1), emails: z.array(z.string().email()).min(1).max(10) });
const scheduleInput = z.object({ campaignId: z.string().min(1), sendAt: z.string().datetime({ offset: true }).describe("ISO 8601 time with offset") });
const subscriberInput = z.object({
	email: z.string().email(),
	firstName: z.string().max(80).optional(),
	tags: z.array(z.string().max(80)).max(20).optional(),
	confirmed: z.boolean().optional().describe("True only if the person already gave consent; otherwise a confirmation email is sent"),
});
const findInput = z.object({ query: z.string().max(200).optional(), status: z.enum(["active", "pending", "unsubscribed", "bounced", "complained"]).optional(), limit: z.number().int().min(1).max(100).optional() });
const listInput = z.object({ status: z.enum(["draft", "scheduled", "testing", "sending", "sent", "canceled", "failed"]).optional(), limit: z.number().int().min(1).max(100).optional() });
const sponsorBookInput = z.object({
	date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Issue date, YYYY-MM-DD in the publication time zone"),
	sponsor: z.string().min(1).max(120),
	headline: z.string().min(1).max(200),
	body: z.string().max(600).optional().describe("1–3 sentences of plain text"),
	url: z.string().url().describe("Where the ad links (https)"),
	ctaLabel: z.string().max(60).optional(),
	imageUrl: z.string().url().optional(),
	hold: z.boolean().optional().describe("Reserve the date without showing the ad yet"),
	priceCents: z.number().int().min(0).optional(),
	contactEmail: z.string().email().optional(),
});
const sponsorListInput = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), days: z.number().int().min(1).max(366).optional() });
const empty = z.object({});

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
	const r = schema.safeParse(input ?? {});
	if (!r.success) throw new Error(`Invalid input: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
	return r.data;
}

const summary = (c: { id: string; name: string; subject: string; status: string; recipientsTotal: number; scheduledAt: number | null; sentAt: number | null; webSlug: string | null }) => ({
	id: c.id,
	name: c.name,
	subject: c.subject,
	status: c.status,
	recipients: c.recipientsTotal,
	scheduledAt: c.scheduledAt ? new Date(c.scheduledAt).toISOString() : null,
	sentAt: c.sentAt ? new Date(c.sentAt).toISOString() : null,
	webSlug: c.webSlug,
});

export function createPlugin(options: PluginOptions = {}) {
	setPluginOptions(options);
	const permission = (options.permission ?? "content:publish_any") as "content:publish_any";
	const schedule = options.cronSchedule ?? "* * * * *";

	const route = <T>(schema: z.ZodType<T>, fn: (input: T) => Promise<unknown>) => ({
		permission,
		handler: async (ctx: { input: unknown }) => fn(parse(schema, ctx.input)),
	});

	return definePlugin({
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		capabilities: ["content:read"],
		admin: {
			pages: ADMIN_PAGES,
			widgets: [{ id: "newsletter-overview", title: "Newsletter", size: "half" }],
		},
		hooks: {
			// EmDash disables a config plugin whose activate hook throws, so this only
			// schedules the cron; missing bindings or secrets surface in the admin instead.
			"plugin:activate": async (_event, ctx) => {
				try {
					await ctx.cron?.schedule(TICK, { schedule });
				} catch (err) {
					ctx.log.error("newsletter: could not schedule the send cron", { error: String(err) });
				}
			},
			cron: {
				timeout: 55_000,
				errorPolicy: "continue",
				handler: async (event, ctx) => {
					if (event.name !== TICK) return;
					await adoptSiteDefaults(ctx.site).catch(() => {});
					const nl = await getNewsletter();
					const r = await nl.tick({ budgetMs: 40_000 });
					if (r.outbox.sent || r.outbox.failed || r.campaigns.started.length || r.outbox.error) {
						ctx.log.info("newsletter tick", { sent: r.outbox.sent, failed: r.outbox.failed, retried: r.outbox.retried, started: r.campaigns.started, finished: r.campaigns.finished, error: r.outbox.error });
					}
				},
			},
			"content:afterPublish": {
				timeout: 30_000,
				errorPolicy: "continue",
				handler: async (event, ctx) => {
					const c = event.content as { id?: string; slug?: string | null; data?: Record<string, unknown> };
					if (!c?.id) return;
					const nl = await getNewsletter();
					const r = await nl.content.campaignFromContent({ collection: event.collection, id: c.id, slug: c.slug ?? null, data: c.data ?? {} });
					if (r.action !== "skipped") ctx.log.info(`newsletter: ${r.action} campaign for ${event.collection}/${c.id}`, { campaign: "campaign" in r ? r.campaign.id : undefined });
				},
			},
		},
		routes: {
			admin: {
				permission,
				handler: async (ctx) => {
					await adoptSiteDefaults(ctx.site).catch(() => {});
					return handleAdmin(await getNewsletter(), ctx.input, ctx.user ? { role: ctx.user.role } : undefined);
				},
			},
			"mcp/stats": route(empty, async () => {
				const nl = await getNewsletter();
				const o = await nl.analytics.overview();
				return { subscribers: o.subscribers, last30Days: o.last30, queue: o.queue, setupProblems: await nl.settings.problems() };
			}),
			"mcp/campaigns": route(listInput, async (i) => (await (await getNewsletter()).campaigns.listCampaigns({ status: i.status, limit: i.limit ?? 20 })).map(summary)),
			"mcp/campaign-stats": route(idInput, async (i) => {
				const nl = await getNewsletter();
				const c = await nl.campaigns.getCampaign(i.campaignId);
				if (!c) throw new Error("Campaign not found");
				return { campaign: summary(c), stats: await nl.analytics.campaignStats(c.id) };
			}),
			"mcp/campaign-create": route(campaignCreateInput, async (i) => {
				const c = await (await getNewsletter()).campaigns.createCampaign({
					subject: i.subject,
					content: i.content,
					preheader: i.preheader ?? null,
					segmentId: i.segmentId ?? null,
					audience: { topic: i.topic ?? null },
					subjectB: i.subjectB ?? null,
					abTestPct: i.subjectB ? (i.abTestPct ?? 10) : 0,
				});
				return { ...summary(c), note: "Created as a draft. Review it in the admin, send a test, then schedule or send." };
			}),
			"mcp/campaign-test": route(testInput, async (i) => (await getNewsletter()).campaigns.sendTest(i.campaignId, i.emails)),
			"mcp/campaign-schedule": route(scheduleInput, async (i) => summary(await (await getNewsletter()).campaigns.scheduleCampaign(i.campaignId, Date.parse(i.sendAt)))),
			"mcp/campaign-send": route(idInput, async (i) => summary(await (await getNewsletter()).campaigns.startCampaign(i.campaignId))),
			"mcp/subscriber-add": route(subscriberInput, async (i) => {
				const r = await (await getNewsletter()).subscribers.subscribe({ email: i.email, firstName: i.firstName, tags: i.tags, confirmed: i.confirmed, source: "mcp" });
				return r.status === "invalid_email" ? { status: r.status } : { status: r.status, id: r.subscriber.id };
			}),
			"mcp/sponsors": route(sponsorListInput, async (i) => {
				const nl = await getNewsletter();
				const from = i.from ?? new Date().toISOString().slice(0, 10);
				return (await nl.sponsors.sponsorCalendar(from, i.days ?? 30)).map((d) => ({
					date: d.date,
					open: !d.slot,
					...(d.slot && { id: d.slot.id, status: d.slot.status, sponsor: d.slot.sponsor, headline: d.slot.headline }),
				}));
			}),
			"mcp/sponsor-book": route(sponsorBookInput, async (i) => {
				const r = await (await getNewsletter()).sponsors.bookSponsorSlot({ ...i, status: i.hold ? "hold" : "booked" });
				if (!r.ok) throw new Error(r.detail);
				return { id: r.slot.id, date: r.slot.date, status: r.slot.status };
			}),
			"mcp/subscribers": route(findInput, async (i) => {
				const r = await (await getNewsletter()).subscribers.listSubscribers({ search: i.query, status: i.status, limit: i.limit ?? 25 });
				return { total: r.total, items: r.items.map((s) => ({ id: s.id, email: s.email, status: s.status, firstName: s.firstName, tags: s.tags, createdAt: new Date(s.createdAt).toISOString() })) };
			}),
		},
		mcp: {
			tools: {
				newsletter_stats: { description: "Newsletter health: subscriber counts, 30-day growth, open/click rates, send queue and setup problems.", route: "mcp/stats", input: empty },
				newsletter_list_campaigns: { description: "List newsletter campaigns (issues), newest first.", route: "mcp/campaigns", input: listInput },
				newsletter_campaign_stats: { description: "Performance of one campaign: sends, opens, clicks, bounces, unsubscribes, top links, A/B results.", route: "mcp/campaign-stats", input: idInput },
				newsletter_create_campaign: { description: "Create a newsletter campaign as a draft (nothing is sent).", route: "mcp/campaign-create", input: campaignCreateInput },
				newsletter_send_test: { description: "Send a test of a campaign to up to 10 addresses.", route: "mcp/campaign-test", input: testInput },
				newsletter_schedule_campaign: { description: "Schedule a campaign to send to its audience at a future time.", route: "mcp/campaign-schedule", input: scheduleInput, destructive: true },
				newsletter_send_campaign: { description: "Send a campaign to its whole audience now. Cannot be undone.", route: "mcp/campaign-send", input: idInput, destructive: true },
				newsletter_add_subscriber: { description: "Add a subscriber. Sends a confirmation email unless confirmed is true.", route: "mcp/subscriber-add", input: subscriberInput },
				newsletter_sponsor_calendar: { description: "Sponsor inventory: each date from `from` (default today) with its booking, or open.", route: "mcp/sponsors", input: sponsorListInput },
				newsletter_book_sponsor: { description: "Book (or hold) a sponsor ad for one issue date. Fails if the date is taken.", route: "mcp/sponsor-book", input: sponsorBookInput },
				newsletter_find_subscribers: { description: "Search subscribers by email or name, optionally by status.", route: "mcp/subscribers", input: findInput },
			},
		},
	});
}

export default createPlugin;
