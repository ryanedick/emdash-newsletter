import type { ConfigPatch } from "../settings.ts";

/** Serializable plugin options (they pass through astro.config.mjs as JSON). */
export interface PluginOptions {
	/** Name of the D1 binding holding the newsletter tables. Default "DB". */
	d1Binding?: string;
	/** Env var with the signing/encryption secret. Default "NEWSLETTER_SECRET", falling back to EMDASH_ENCRYPTION_KEY. */
	secretEnv?: string;
	/** Config fixed in code (wins over the admin settings), e.g. siteUrl or publicBasePath. */
	config?: ConfigPatch;
	/** Cron expression for background sending. Default every minute. */
	cronSchedule?: string;
	/** RBAC permission needed to use the newsletter admin. Default "content:publish_any" (Editors and up). */
	permission?: string;
}
