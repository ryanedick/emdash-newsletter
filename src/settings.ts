/**
 * Newsletter configuration: stored in `nl_settings` (edited from the EmDash
 * admin), with secrets encrypted at rest, and optionally overridden from code.
 */
import type { Signer } from "./crypto.ts";
import type { Db } from "./db.ts";
import { type ProviderSettings, SECRET_KEYS } from "./transport/factory.ts";
import { now, parseJson } from "./util.ts";

export interface ReferralMilestone {
	/** Confirmed referrals needed. */
	count: number;
	/** Shown to subscribers, e.g. "1 month of Pro". */
	reward: string;
	/** Tag added to the referrer when they reach it (drives automations or fulfilment). */
	tag?: string;
}

export interface SponsorConfig {
	/** Show the booked sponsor (Newsletter → Sponsors) in issues sent on that date. */
	enabled: boolean;
	/** Heading above the ad, e.g. "Sponsored by" or "Today's sponsor". */
	label: string;
	/** Subscribers with any of these tags never see the ad (e.g. paying members). */
	hideForTags: string[];
	/** Only issues created by auto-send (publish → email) carry the ad; one-off campaigns don't. */
	autoIssuesOnly: boolean;
}

export type AutoSendMode = "off" | "draft" | "send";

export interface AutoSendConfig {
	/** EmDash collection whose publishes become newsletter issues, e.g. "posts". */
	collection: string;
	mode: AutoSendMode;
	titleField: string;
	excerptField: string;
	/** Portable Text field rendered as the email body. Leave empty to send the excerpt + link only. */
	bodyField: string;
	/** Public URL pattern for "read on the web" links. `{slug}` and `{id}` are replaced. */
	urlPattern: string;
	/**
	 * Optional date field (e.g. "issue_date"). In "send" mode, an entry whose date is
	 * in the future is scheduled for that moment instead of sending on publish, so
	 * editors can approve tomorrow's issue tonight. Blank = send on publish.
	 */
	sendAtField: string;
	/** "all" or a segment ID. */
	audience: string;
	/** Subject template. `{title}` is replaced. */
	subjectTemplate: string;
	/** Also publish the issue in the web archive. */
	publishWeb: boolean;
	/**
	 * Extra fields appended after the body. Strings become paragraphs; arrays of
	 * objects (repeaters) become callout boxes, first value as the title.
	 */
	extraFields: string[];
	/** Who can read the archived issue: "public" or "members" (see the canViewArchive hook). */
	webAccess: "public" | "members";
	/** Label of the button linking to the full post. Empty hides it. */
	readMoreLabel: string;
}

export interface NewsletterConfig {
	publicationName: string;
	/** Absolute site origin, e.g. https://example.com. Links in emails are built from it. */
	siteUrl: string;
	/** Where the site mounts the public handler (confirm, unsubscribe, tracking, webhooks). */
	publicBasePath: string;
	from: { email: string; name: string };
	replyTo: string;
	/** Physical mailing address for the footer (CAN-SPAM). */
	postalAddress: string;
	provider: ProviderSettings | null;
	doubleOptIn: boolean;
	trackOpens: boolean;
	trackClicks: boolean;
	/** Provider send ceiling. The sender never exceeds it. */
	sendRatePerMinute: number;
	brand: { accentColor: string; logoUrl: string; footerText: string };
	confirmation: { subject: string; intro: string };
	welcome: { enabled: boolean; subject: string; content: string };
	referrals: { enabled: boolean; milestones: ReferralMilestone[] };
	sponsors: SponsorConfig;
	autoSend: AutoSendConfig;
	/** Webhook signing secrets per provider (Bird/Resend: whsec_…, Mailgun: signing key). */
	webhookSecrets: Record<string, string>;
	/** Cloudflare Turnstile secret. When set, the subscribe endpoint requires a token. */
	turnstileSecret: string;
	/** Topics new subscribers get when they don't choose (slugs). Empty = all default topics. */
	defaultTopics: string[];
	/** IANA time zone for scheduling in the admin, e.g. America/New_York. */
	timezone: string;
}

export const DEFAULT_CONFIG: NewsletterConfig = {
	publicationName: "Newsletter",
	siteUrl: "",
	publicBasePath: "/newsletter",
	from: { email: "", name: "" },
	replyTo: "",
	postalAddress: "",
	provider: null,
	doubleOptIn: true,
	trackOpens: true,
	trackClicks: true,
	sendRatePerMinute: 600,
	brand: { accentColor: "#4f3cc9", logoUrl: "", footerText: "" },
	confirmation: {
		subject: "Confirm your subscription to {{publication}}",
		intro: "Tap the button below to confirm your email address and start receiving {{publication}}.",
	},
	welcome: { enabled: false, subject: "Welcome to {{publication}}", content: "Thanks for subscribing! Here's what to expect." },
	referrals: { enabled: false, milestones: [] },
	sponsors: { enabled: false, label: "Sponsored by", hideForTags: [], autoIssuesOnly: true },
	autoSend: {
		collection: "",
		mode: "off",
		titleField: "title",
		excerptField: "excerpt",
		bodyField: "content",
		urlPattern: "/{collection}/{slug}",
		sendAtField: "",
		audience: "all",
		subjectTemplate: "{title}",
		publishWeb: true,
		extraFields: [],
		webAccess: "public",
		readMoreLabel: "Read on the site",
	},
	webhookSecrets: {},
	turnstileSecret: "",
	defaultTopics: [],
	timezone: "UTC",
};

export type ConfigPatch = { [K in keyof NewsletterConfig]?: NewsletterConfig[K] extends object ? Partial<NewsletterConfig[K]> | NewsletterConfig[K] : NewsletterConfig[K] };

function merge<T>(base: T, patch: unknown): T {
	if (patch === undefined || patch === null) return base;
	if (typeof base !== "object" || base === null || Array.isArray(base) || typeof patch !== "object" || Array.isArray(patch)) {
		return patch as T;
	}
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
		if (v === undefined) continue;
		out[k] = k in out && out[k] && typeof out[k] === "object" && !Array.isArray(out[k]) && v && typeof v === "object" && !Array.isArray(v) ? merge(out[k], v) : v;
	}
	return out as T;
}

async function mapSecrets(cfg: NewsletterConfig, fn: (v: string) => Promise<string | null>): Promise<NewsletterConfig> {
	const out: NewsletterConfig = structuredClone(cfg);
	if (out.provider) {
		for (const k of SECRET_KEYS) {
			const v = out.provider[k];
			if (typeof v === "string" && v) (out.provider as unknown as Record<string, unknown>)[k] = (await fn(v)) ?? "";
		}
	}
	for (const [k, v] of Object.entries(out.webhookSecrets)) if (v) out.webhookSecrets[k] = (await fn(v)) ?? "";
	if (out.turnstileSecret) out.turnstileSecret = (await fn(out.turnstileSecret)) ?? "";
	return out;
}

export class Settings {
	#db: Db;
	#signer: Signer;
	#overrides: ConfigPatch;
	#cache: { at: number; value: NewsletterConfig } | null = null;

	constructor(db: Db, signer: Signer, overrides: ConfigPatch = {}) {
		this.#db = db;
		this.#signer = signer;
		this.#overrides = overrides;
	}

	/** Stored config, decrypted, with code overrides applied. Cached for 10s per isolate. */
	async get(): Promise<NewsletterConfig> {
		if (this.#cache && now() - this.#cache.at < 10_000) return this.#cache.value;
		const stored = await this.stored();
		const value = merge(stored, this.#overrides);
		this.#cache = { at: now(), value };
		return value;
	}

	/** Stored config without code overrides (what the admin form edits). */
	async stored(): Promise<NewsletterConfig> {
		const row = await this.#db.prepare(`SELECT value FROM nl_settings WHERE key = 'config'`).first<{ value: string }>();
		const raw = merge(DEFAULT_CONFIG, parseJson<Partial<NewsletterConfig>>(row?.value, {}));
		return mapSecrets(raw, (v) => this.#signer.decrypt(v));
	}

	/**
	 * Saves a partial update. Secret fields left empty keep their current value,
	 * so the admin form never has to echo secrets back.
	 */
	async update(patch: ConfigPatch): Promise<NewsletterConfig> {
		const current = await this.stored();
		const p = structuredClone(patch) as ConfigPatch;
		if (p.provider && current.provider && (p.provider as ProviderSettings).type === current.provider.type) {
			for (const k of SECRET_KEYS) {
				if (!(p.provider as unknown as Record<string, unknown>)[k]) (p.provider as unknown as Record<string, unknown>)[k] = current.provider[k];
			}
		}
		if (p.webhookSecrets) {
			for (const [k, v] of Object.entries(p.webhookSecrets)) if (!v && current.webhookSecrets[k]) (p.webhookSecrets as Record<string, string>)[k] = current.webhookSecrets[k];
		}
		if (p.turnstileSecret === "") delete p.turnstileSecret;
		const next = merge(current, p);
		if (p.provider) next.provider = { ...(p.provider as ProviderSettings) };
		if (p.referrals?.milestones) next.referrals.milestones = p.referrals.milestones as ReferralMilestone[];
		if (p.sponsors?.hideForTags) next.sponsors.hideForTags = p.sponsors.hideForTags as string[];
		const encrypted = await mapSecrets(next, (v) => (v.startsWith("enc:v1:") ? Promise.resolve(v) : this.#signer.encrypt(v)));
		await this.#db
			.prepare(
				`INSERT INTO nl_settings (key, value, updated_at) VALUES ('config', ?, ?)
				 ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
			)
			.bind(JSON.stringify(encrypted), now())
			.run();
		this.#cache = null;
		return this.get();
	}

	invalidate() {
		this.#cache = null;
	}

	/** Top-level settings fixed in code (they win over anything saved in the admin). */
	overriddenKeys(): (keyof NewsletterConfig)[] {
		return (Object.keys(this.#overrides) as (keyof NewsletterConfig)[]).filter((k) => this.#overrides[k] !== undefined);
	}
}

export const SETTING_LABELS: Partial<Record<keyof NewsletterConfig, string>> = {
	publicationName: "Publication name",
	siteUrl: "Site URL",
	publicBasePath: "Public path",
	from: "From address",
	replyTo: "Reply-to",
	postalAddress: "Postal address",
	provider: "Email provider",
	doubleOptIn: "Double opt-in",
	trackOpens: "Open tracking",
	trackClicks: "Click tracking",
	sendRatePerMinute: "Send rate",
	brand: "Branding",
	autoSend: "Publish → email",
	referrals: "Referrals",
	webhookSecrets: "Webhook secrets",
	turnstileSecret: "Turnstile secret",
	timezone: "Time zone",
};

/** Problems that stop sending, for the admin checklist. */
export function configProblems(c: NewsletterConfig): string[] {
	const p: string[] = [];
	if (!c.provider) p.push("Choose an email provider in Settings.");
	if (!c.from.email) p.push("Set a From address on your verified sending domain.");
	if (!c.siteUrl) p.push("Set the site URL so email links work.");
	if (!c.postalAddress) p.push("Add a postal address for the email footer (required by CAN-SPAM).");
	return p;
}
