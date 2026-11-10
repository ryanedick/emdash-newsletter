/** Builds the signed per-recipient URLs that go into emails. */
import { type Core, publicUrl } from "./core.ts";
import type { NewsletterConfig } from "./settings.ts";

export const CONFIRM_TTL = 7 * 24 * 3600 * 1000;

export async function confirmUrl(core: Core, c: NewsletterConfig, subscriberId: string): Promise<string> {
	return publicUrl(c, `/confirm?t=${await core.signer.sign("confirm", { s: subscriberId }, CONFIRM_TTL)}`);
}

export async function unsubscribeUrl(core: Core, c: NewsletterConfig, subscriberId: string, campaignId?: string | null): Promise<string> {
	return publicUrl(c, `/u?t=${await core.signer.sign("unsub", { s: subscriberId, ...(campaignId ? { c: campaignId } : {}) })}`);
}

export async function preferencesUrl(core: Core, c: NewsletterConfig, subscriberId: string): Promise<string> {
	return publicUrl(c, `/preferences?t=${await core.signer.sign("prefs", { s: subscriberId })}`);
}

export function referralUrl(c: NewsletterConfig, code: string): string {
	return publicUrl(c, `/r/${encodeURIComponent(code)}`);
}

export function webIssueUrl(c: NewsletterConfig, slug: string): string {
	return publicUrl(c, `/p/${encodeURIComponent(slug)}`);
}

export async function clickUrl(core: Core, c: NewsletterConfig, outboxId: string, linkId: number, mac?: string): Promise<string> {
	const m = mac ?? (await core.signer.mac("track", outboxId));
	return publicUrl(c, `/c/${outboxId}.${linkId}.${m}`);
}

export async function openPixelUrl(core: Core, c: NewsletterConfig, outboxId: string, mac?: string): Promise<string> {
	const m = mac ?? (await core.signer.mac("track", outboxId));
	return publicUrl(c, `/o/${outboxId}.${m}.gif`);
}
