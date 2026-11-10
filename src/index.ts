export { createNewsletter, type Newsletter, type NewsletterOptions } from "./newsletter.ts";
export { createNewsletterHandler, type HandlerOptions } from "./handler.ts";
export { defaultShell, type PageShell, type PageShellInput } from "./pages.ts";
export { type Db, type DbStatement, ensureSchema } from "./db.ts";
export type { Logger, NewsletterHooks, Subscriber, SubscriberStatus } from "./core.ts";
export {
	type AutoSendConfig,
	type ConfigPatch,
	configProblems,
	DEFAULT_CONFIG,
	type NewsletterConfig,
	type ReferralMilestone,
	type SponsorConfig,
} from "./settings.ts";
export type { Campaign, CampaignInput, CampaignStatus } from "./campaigns.ts";
export type { Audience, Segment, SegmentCondition, SegmentRules } from "./segments.ts";
export type { Automation, AutomationStep, AutomationTrigger } from "./automations.ts";
export type { SponsorInput, SponsorSaveResult, SponsorSlot, SponsorStatus } from "./sponsors.ts";
export type { SubscribeInput, SubscribeResult, Topic } from "./subscribers.ts";
export type { ContentEntry } from "./content.ts";
export type { CampaignStats, Overview } from "./analytics.ts";
export { markdownToHtml, markdownToText } from "./render/markdown.ts";
export { portableTextToHtml, type PtBlock, type PtOptions } from "./render/portable-text.ts";
export { emailStyles, htmlToText, layout } from "./render/email.ts";
export * from "./transport/index.ts";
