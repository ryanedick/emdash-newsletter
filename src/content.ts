/**
 * Turns a published CMS entry into a newsletter issue (the "publish → email"
 * automation). Called from the EmDash `content:afterPublish` hook, or directly.
 * Idempotent per entry: re-publishing an entry never sends it twice.
 */
import { type Campaign, createCampaign, getCampaignBySource, scheduleCampaign, startCampaign } from "./campaigns.ts";
import type { Core } from "./core.ts";
import type { PtBlock } from "./render/portable-text.ts";
import type { AutoSendConfig } from "./settings.ts";

export interface ContentEntry {
	collection: string;
	id: string;
	slug?: string | null;
	data: Record<string, unknown>;
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

function textBlock(text: string, style = "normal"): PtBlock {
	return { _type: "block", style, children: [{ _type: "span", text }], markDefs: [] };
}

export function entryUrl(siteUrl: string, pattern: string, e: ContentEntry): string {
	const path = pattern
		.replace("{collection}", encodeURIComponent(e.collection))
		.replace("{slug}", encodeURIComponent(e.slug ?? e.id))
		.replace("{id}", encodeURIComponent(e.id));
	return /^https?:/.test(path) ? path : `${siteUrl.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Builds the Portable Text body of an issue from an entry. */
export function buildIssueBody(e: ContentEntry, cfg: AutoSendConfig, url: string): PtBlock[] {
	const blocks: PtBlock[] = [];
	const title = str(e.data[cfg.titleField]);
	const excerpt = str(e.data[cfg.excerptField]);
	if (title) blocks.push(textBlock(title, "h1"));
	const body = cfg.bodyField ? e.data[cfg.bodyField] : undefined;
	if (Array.isArray(body) && body.length) {
		if (excerpt) blocks.push({ ...textBlock(excerpt), children: [{ _type: "span", text: excerpt, marks: ["em"] }] });
		blocks.push(...(body as PtBlock[]));
	} else if (excerpt) {
		blocks.push(textBlock(excerpt));
	}
	for (const field of cfg.extraFields ?? []) {
		const v = e.data[field];
		if (typeof v === "string" && v.trim()) blocks.push(textBlock(v));
		else if (Array.isArray(v)) {
			for (const item of v) {
				if (!item || typeof item !== "object") continue;
				const values = Object.entries(item as Record<string, unknown>)
					.filter(([k, val]) => !k.startsWith("_") && typeof val === "string" && val.trim())
					.map(([, val]) => val as string);
				if (values.length === 1) blocks.push({ _type: "callout", text: values[0] });
				else if (values.length > 1) blocks.push({ _type: "callout", title: values[0], text: values.slice(1).join("\n\n") });
			}
		}
	}
	if (cfg.readMoreLabel) blocks.push({ _type: "button", label: cfg.readMoreLabel, url });
	return blocks;
}

/** The entry's send time from `sendAtField`, or null when unset or unparseable. */
export function sendAtOf(e: ContentEntry, cfg: AutoSendConfig): number | null {
	if (!cfg.sendAtField) return null;
	const v = e.data[cfg.sendAtField];
	const t = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : v instanceof Date ? v.getTime() : Number.NaN;
	return Number.isFinite(t) ? t : null;
}

export type ContentSendResult =
	| { action: "skipped"; reason: string }
	| { action: "draft" | "sent" | "scheduled"; campaign: Campaign }
	| { action: "exists"; campaign: Campaign };

export async function campaignFromContent(core: Core, e: ContentEntry, opts: { force?: boolean; mode?: "draft" | "send" } = {}): Promise<ContentSendResult> {
	const config = await core.settings.get();
	const cfg = config.autoSend;
	const mode = opts.mode ?? (cfg.mode === "off" ? null : cfg.mode);
	if (!opts.force && (!mode || cfg.collection !== e.collection)) return { action: "skipped", reason: "auto-send is off for this collection" };
	const sourceRef = `content:${e.collection}:${e.id}`;
	const existing = await getCampaignBySource(core, sourceRef);
	if (existing) {
		// Editor moved the date of an issue that hasn't gone out yet: follow it.
		const sendAt = sendAtOf(e, cfg);
		if (existing.status === "scheduled" && sendAt && sendAt > Date.now() + 60_000 && sendAt !== existing.scheduledAt) {
			return { action: "exists", campaign: await scheduleCampaign(core, existing.id, sendAt) };
		}
		return { action: "exists", campaign: existing };
	}

	const title = str(e.data[cfg.titleField]) || e.slug || "New issue";
	const url = entryUrl(config.siteUrl, cfg.urlPattern, e);
	const campaign = await createCampaign(core, {
		name: title,
		subject: cfg.subjectTemplate.replace("{title}", title),
		preheader: str(e.data[cfg.excerptField]).slice(0, 200) || null,
		contentFormat: "portable_text",
		content: JSON.stringify(buildIssueBody(e, cfg, url)),
		segmentId: cfg.audience && cfg.audience !== "all" ? cfg.audience : null,
		sourceRef,
		webSlug: e.slug ?? undefined,
		publishWeb: cfg.publishWeb,
		webAccess: cfg.webAccess,
	});
	if (mode === "send") {
		const sendAt = sendAtOf(e, cfg);
		if (sendAt && sendAt > Date.now() + 60_000) return { action: "scheduled", campaign: await scheduleCampaign(core, campaign.id, sendAt) };
		const started = await startCampaign(core, campaign.id);
		return { action: "sent", campaign: started };
	}
	return { action: "draft", campaign };
}
