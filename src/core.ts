/** Shared context every engine module receives. */
import type { Signer } from "./crypto.ts";
import type { Db } from "./db.ts";
import type { NewsletterConfig, ReferralMilestone, Settings } from "./settings.ts";
import type { EmailTransport } from "./transport/types.ts";

export type SubscriberStatus = "pending" | "active" | "unsubscribed" | "bounced" | "complained";

export interface Subscriber {
	id: string;
	email: string;
	status: SubscriberStatus;
	firstName: string | null;
	lastName: string | null;
	attributes: Record<string, string>;
	source: string | null;
	utm: Record<string, string> | null;
	referralCode: string;
	referredBy: string | null;
	consentIp: string | null;
	consentAt: number | null;
	confirmedAt: number | null;
	unsubscribedAt: number | null;
	lastOpenAt: number | null;
	lastClickAt: number | null;
	createdAt: number;
	updatedAt: number;
	tags?: string[];
}

export interface NewsletterHooks {
	/** A subscriber became active (confirmed, or added without double opt-in). */
	onSubscribed?(subscriber: Subscriber): void | Promise<void>;
	onUnsubscribed?(subscriber: Subscriber, reason: string): void | Promise<void>;
	/** A referrer reached a milestone. Fulfil the reward here (e.g. grant a Pro month). */
	onReferralMilestone?(referrer: Subscriber, milestone: ReferralMilestone, confirmedReferrals: number): void | Promise<void>;
	/**
	 * Decides whether a web-archive visitor may read a members-only issue.
	 * Without this hook, members-only issues show only their preheader.
	 */
	canViewArchive?(request: Request, issue: { id: string; webAccess: string }): boolean | Promise<boolean>;
}

export interface Logger {
	info(msg: string, data?: Record<string, unknown>): void;
	warn(msg: string, data?: Record<string, unknown>): void;
	error(msg: string, data?: Record<string, unknown>): void;
}

export const consoleLogger: Logger = {
	info: (m, d) => console.log(`[newsletters] ${m}`, d ?? ""),
	warn: (m, d) => console.warn(`[newsletters] ${m}`, d ?? ""),
	error: (m, d) => console.error(`[newsletters] ${m}`, d ?? ""),
};

export interface Core {
	db: Db;
	signer: Signer;
	settings: Settings;
	hooks: NewsletterHooks;
	log: Logger;
	/** The configured provider transport. Throws when none is configured. */
	transport(config?: NewsletterConfig): Promise<EmailTransport>;
	/** Absolute URL of the public handler: siteUrl + publicBasePath + path. */
	url(config: NewsletterConfig, path: string): string;
}

export function publicUrl(config: NewsletterConfig, path: string): string {
	const base = `${config.siteUrl.replace(/\/$/, "")}${config.publicBasePath.replace(/\/$/, "")}`;
	return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export function mapSubscriber(r: Record<string, unknown>): Subscriber {
	const json = <T>(v: unknown, f: T): T => {
		if (typeof v !== "string" || !v) return f;
		try {
			return JSON.parse(v) as T;
		} catch {
			return f;
		}
	};
	return {
		id: r.id as string,
		email: r.email as string,
		status: r.status as SubscriberStatus,
		firstName: (r.first_name as string) ?? null,
		lastName: (r.last_name as string) ?? null,
		attributes: json(r.attributes, {}),
		source: (r.source as string) ?? null,
		utm: json(r.utm, null),
		referralCode: r.referral_code as string,
		referredBy: (r.referred_by as string) ?? null,
		consentIp: (r.consent_ip as string) ?? null,
		consentAt: (r.consent_at as number) ?? null,
		confirmedAt: (r.confirmed_at as number) ?? null,
		unsubscribedAt: (r.unsubscribed_at as number) ?? null,
		lastOpenAt: (r.last_open_at as number) ?? null,
		lastClickAt: (r.last_click_at as number) ?? null,
		createdAt: r.created_at as number,
		updatedAt: r.updated_at as number,
		...(typeof r.tags === "string" ? { tags: r.tags ? (r.tags as string).split("\u001f") : [] } : {}),
	};
}
