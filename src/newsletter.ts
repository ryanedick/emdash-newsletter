/**
 * `createNewsletter()`: the one object a site or plugin needs. It binds every
 * engine module to a database, a secret and (optionally) code-level config.
 */
import * as analytics from "./analytics.ts";
import * as automations from "./automations.ts";
import * as campaigns from "./campaigns.ts";
import * as content from "./content.ts";
import { type Core, consoleLogger, type Logger, type NewsletterHooks, publicUrl } from "./core.ts";
import { Signer } from "./crypto.ts";
import { type Db, ensureSchema } from "./db.ts";
import * as events from "./events.ts";
import * as segments from "./segments.ts";
import * as sender from "./sender.ts";
import * as sponsors from "./sponsors.ts";
import { type ConfigPatch, configProblems, type NewsletterConfig, Settings } from "./settings.ts";
import * as subscribers from "./subscribers.ts";
import { createTransport, type TransportDeps } from "./transport/factory.ts";
import type { EmailTransport } from "./transport/types.ts";
import { now } from "./util.ts";

export interface NewsletterOptions {
	db: Db;
	/**
	 * Secret for signing links and encrypting provider credentials (≥16 chars).
	 * Keep it stable: rotating it invalidates unsubscribe links in sent emails
	 * and makes stored provider keys unreadable.
	 */
	secret: string;
	/** Config set in code. Wins over values saved in the admin. */
	config?: ConfigPatch;
	hooks?: NewsletterHooks;
	/** Use this transport instead of the configured provider (tests, custom providers). */
	transport?: EmailTransport | ((config: NewsletterConfig) => EmailTransport);
	/** Injected fetch / socket factory for the built-in transports. */
	deps?: TransportDeps;
	logger?: Logger;
}

type Bound<F> = F extends (core: Core, ...args: infer A) => infer R ? (...args: A) => R : never;

/** Binds the named core-taking functions of a module to `core`. */
function bind<T extends Record<string, unknown>, K extends keyof T>(core: Core, mod: T, names: K[]): { [P in K]: Bound<T[P]> } {
	const out: Record<string, unknown> = {};
	for (const k of names) {
		const fn = mod[k] as (...x: unknown[]) => unknown;
		out[k as string] = (...a: unknown[]) => fn(core, ...a);
	}
	return out as { [P in K]: Bound<T[P]> };
}

export function createNewsletter(options: NewsletterOptions) {
	const signer = new Signer(options.secret);
	const settings = new Settings(options.db, signer, options.config);
	let cached: { key: string; transport: EmailTransport } | null = null;

	const core: Core = {
		db: options.db,
		signer,
		settings,
		hooks: options.hooks ?? {},
		log: options.logger ?? consoleLogger,
		async transport(config) {
			const c = config ?? (await settings.get());
			if (options.transport) return typeof options.transport === "function" ? options.transport(c) : options.transport;
			if (!c.provider) throw new Error("No email provider configured. Choose one in Newsletter → Settings.");
			const key = JSON.stringify(c.provider);
			if (cached?.key !== key) cached = { key, transport: createTransport(c.provider, options.deps) };
			return cached.transport;
		},
		url: publicUrl,
	};

	const ready = () => ensureSchema(options.db);
	/** Wraps every method so the schema is migrated before first use. */
	function withSchema<T extends Record<string, unknown>>(o: T): T {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(o)) {
			out[k] = typeof v === "function" ? async (...a: unknown[]) => (await ready(), (v as (...x: unknown[]) => unknown)(...a)) : v;
		}
		return out as T;
	}

	const api = {
		subscribers: withSchema(
			bind(core, subscribers, [
				"subscribe",
				"confirmByToken",
				"activate",
				"unsubscribe",
				"unsubscribeByToken",
				"getSubscriber",
				"getSubscriberByEmail",
				"listSubscribers",
				"updateSubscriber",
				"updatePreferences",
				"addTags",
				"removeTags",
				"deleteSubscriber",
				"importCsv",
				"exportCsv",
				"listTopics",
				"saveTopic",
				"deleteTopic",
				"referralStats",
			]),
		),
		campaigns: withSchema(
			bind(core, campaigns, [
				"createCampaign",
				"updateCampaign",
				"getCampaign",
				"getCampaignBySlug",
				"listCampaigns",
				"listArchive",
				"duplicateCampaign",
				"deleteCampaign",
				"scheduleCampaign",
				"unscheduleCampaign",
				"startCampaign",
				"cancelCampaign",
				"sendTest",
				"renderCampaignFor",
				"tickCampaigns",
			]),
		),
		segments: withSchema(bind(core, segments, ["createSegment", "updateSegment", "getSegment", "listSegments", "deleteSegment", "countAudience"])),
		automations: withSchema(
			bind(core, automations, ["listAutomations", "getAutomation", "saveAutomation", "deleteAutomation", "enroll", "runAutomations", "automationStats"]),
		),
		sponsors: withSchema(
			bind(core, sponsors, [
				"listSponsorSlots",
				"getSponsorSlot",
				"sponsorForDate",
				"bookSponsorSlot",
				"updateSponsorSlot",
				"cancelSponsorSlot",
				"deleteSponsorSlot",
				"sponsorCalendar",
				"sponsorClicks",
			]),
		),
		events: withSchema(bind(core, events, ["recordOpen", "recordClick", "handleWebhook", "applyDeliveryEvent"])),
		analytics: withSchema(bind(core, analytics, ["overview", "campaignStats"])),
		content: withSchema(bind(core, content, ["campaignFromContent"])),
		outbox: withSchema(bind(core, sender, ["drain", "enqueueTransactional", "queueDepth"])),
	};

	return {
		core,
		...api,
		ready,
		settings: {
			get: async () => (await ready(), settings.get()),
			stored: async () => (await ready(), settings.stored()),
			update: async (patch: ConfigPatch) => (await ready(), settings.update(patch)),
			problems: async () => (await ready(), configProblems(await settings.get())),
			/** Settings fixed in code; admin edits to these don't apply. */
			overridden: () => settings.overriddenKeys(),
		},
		/** Verifies provider credentials without sending. */
		async verifyProvider(): Promise<{ ok: boolean; detail: string }> {
			await ready();
			try {
				const t = await core.transport();
				return t.verify ? await t.verify() : { ok: true, detail: `${t.name} has no credential check; send a test email to confirm.` };
			} catch (err) {
				return { ok: false, detail: (err as Error).message };
			}
		},
		/** Sends a plain test message through the configured provider. */
		async sendProviderTest(to: string): Promise<{ ok: boolean; detail: string }> {
			await ready();
			const config = await settings.get();
			try {
				const t = await core.transport(config);
				const r = await t.send({
					from: { email: config.from.email, name: config.from.name || config.publicationName },
					to,
					subject: `${config.publicationName}: provider test`,
					text: `This is a test from your newsletter. It was sent through ${t.name}.`,
					html: `<p>This is a test from your newsletter. It was sent through <strong>${t.name}</strong>.</p>`,
					category: "test",
				});
				return { ok: true, detail: `Sent through ${t.name}${r.messageId ? ` (id ${r.messageId})` : ""}` };
			} catch (err) {
				return { ok: false, detail: (err as Error).message };
			}
		},
		/**
		 * Background work. Call it every minute (EmDash plugin cron, or a Worker
		 * scheduled handler): starts scheduled campaigns, decides A/B winners,
		 * advances automations and drains the outbox within the time budget.
		 */
		async tick(opts: { budgetMs?: number } = {}) {
			await ready();
			const started = now();
			const camp = await campaigns.tickCampaigns(core);
			const auto = await automations.runAutomations(core);
			const sent = await sender.drain(core, { budgetMs: Math.max(1000, (opts.budgetMs ?? 25_000) - (now() - started)) });
			// Finish campaigns whose last rows just went out.
			const after = sent.sent > 0 ? await campaigns.tickCampaigns(core) : { finished: [] as string[] };
			if (Math.random() < 0.02) {
				await options.db.prepare(`DELETE FROM nl_webhook_seen WHERE received_at < ?`).bind(now() - 7 * 86400_000).run();
			}
			return { campaigns: { ...camp, finished: [...camp.finished, ...after.finished] }, automations: auto, outbox: sent };
		},
		/** The URL providers should post events to (includes the auth key). */
		async webhookUrl(provider: string): Promise<string> {
			await ready();
			const config = await settings.get();
			return publicUrl(config, `/webhooks/${provider}?key=${await events.webhookToken(core)}`);
		},
	};
}

export type Newsletter = ReturnType<typeof createNewsletter>;
