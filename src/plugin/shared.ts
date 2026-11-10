/**
 * One Newsletter instance per isolate, shared by the EmDash plugin and the
 * site's public route. Works on Cloudflare Workers (reads bindings from
 * `cloudflare:workers`); pass explicit options elsewhere.
 */
import type { NewsletterHooks } from "../core.ts";
import { createNewsletter, type Newsletter, type NewsletterOptions } from "../newsletter.ts";
import type { PluginOptions } from "./options.ts";

let instance: Newsletter | null = null;
let hooks: NewsletterHooks = {};
let pluginOptions: PluginOptions = {};
let explicit: Partial<NewsletterOptions> | null = null;

/** Register site hooks (referral rewards, members-only archive, sync to your CRM…). */
export function setNewsletterHooks(h: NewsletterHooks) {
	hooks = h;
	if (instance) Object.assign(instance.core.hooks, h);
}

/** Override how the instance is built (non-Cloudflare hosts, tests, custom transports). */
export function configureNewsletter(opts: Partial<NewsletterOptions>) {
	explicit = opts;
	instance = null;
}

/** Called by the plugin runtime and the injected route with the astro.config options. */
export function setPluginOptions(o: PluginOptions) {
	if (JSON.stringify(o ?? {}) === JSON.stringify(pluginOptions)) return;
	pluginOptions = o ?? {};
	instance = null; // rebuild with the new binding/secret names
}

async function cloudflareEnv(): Promise<Record<string, unknown>> {
	try {
		return ((await import("cloudflare:workers")) as unknown as { env: Record<string, unknown> }).env ?? {};
	} catch {
		return {};
	}
}

let siteDefaultsDone = false;

/**
 * Fills the publication name and site URL from EmDash's own site settings the
 * first time the plugin runs, so a new install needs no extra setup for them.
 * Only empty/default values are filled; nothing the admin saved is changed.
 */
export async function adoptSiteDefaults(site: { name?: string; url?: string } | undefined): Promise<void> {
	if (siteDefaultsDone || !site) return;
	const nl = await getNewsletter();
	const stored = await nl.settings.stored();
	const patch: { publicationName?: string; siteUrl?: string } = {};
	if (stored.publicationName === "Newsletter" && site.name?.trim()) patch.publicationName = site.name.trim();
	if (!stored.siteUrl && /^https?:\/\//.test(site.url ?? "")) patch.siteUrl = (site.url as string).replace(/\/$/, "");
	if (Object.keys(patch).length) await nl.settings.update(patch);
	siteDefaultsDone = true;
}

export async function getNewsletter(): Promise<Newsletter> {
	if (instance) return instance;
	const env = await cloudflareEnv();
	const db = explicit?.db ?? (env[pluginOptions.d1Binding ?? "DB"] as NewsletterOptions["db"] | undefined);
	const secret =
		explicit?.secret ?? ((env[pluginOptions.secretEnv ?? "NEWSLETTER_SECRET"] as string | undefined) || (env.EMDASH_ENCRYPTION_KEY as string | undefined));
	if (!db) throw new Error(`emdash-newsletter: D1 binding "${pluginOptions.d1Binding ?? "DB"}" not found`);
	if (!secret) throw new Error("emdash-newsletter: set the NEWSLETTER_SECRET secret (32+ random characters)");
	instance = createNewsletter({
		...explicit,
		db,
		secret,
		config: { ...(pluginOptions.config ?? {}), ...(explicit?.config ?? {}) },
		hooks: { ...hooks, ...(explicit?.hooks ?? {}) },
	});
	return instance;
}
