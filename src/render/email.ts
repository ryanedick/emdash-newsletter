/**
 * Turns campaign content into a finished, per-recipient email: body rendering,
 * merge tags, the responsive layout with compliant footer, link tracking and
 * the open pixel.
 */
import type { NewsletterConfig } from "../settings.ts";
import { escapeHtml, stripHtml } from "../util.ts";
import { markdownToHtml, markdownToText } from "./markdown.ts";
import { type PtOptions, portableTextToHtml } from "./portable-text.ts";
import { type EmailStyles, emailStyles, FONT_STACK } from "./styles.ts";

export type ContentFormat = "markdown" | "html" | "portable_text";

export interface RenderedBody {
	html: string;
	text: string;
}

export function renderBody(format: ContentFormat, content: string, styles: EmailStyles, pt: PtOptions = {}): RenderedBody {
	if (format === "markdown") return { html: markdownToHtml(content, styles), text: markdownToText(content) };
	if (format === "portable_text") {
		let value: unknown = [];
		try {
			value = JSON.parse(content);
		} catch {}
		const html = portableTextToHtml(value, styles, pt);
		return { html, text: htmlToText(html) };
	}
	return { html: content, text: htmlToText(content) };
}

/** HTML → readable plain text: links become "text (url)", blocks become paragraphs. */
export function htmlToText(html: string): string {
	const withLinks = html
		.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
		.replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, text: string) => {
			const t = stripHtml(text).trim();
			const h = href.replace(/&amp;/g, "&");
			return t && t !== h ? `${t} (${h})` : h;
		})
		.replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, "$1")
		.replace(/<li[^>]*>/gi, "\n- ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|h[1-6]|blockquote|pre|ul|ol|div|tr|table)>/gi, "\n\n")
		.replace(/<hr[^>]*>/gi, "\n----\n");
	return stripHtml(withLinks)
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export type MergeVars = Record<string, string | number | null | undefined>;

/**
 * `{{first_name}}`, `{{first_name|there}}` (fallback), `{{attr.company}}`.
 * Values are HTML-escaped in HTML mode. Unknown tags render as the fallback or empty.
 */
export function applyMergeTags(input: string, vars: MergeVars, mode: "html" | "text"): string {
	return input.replace(/\{\{\s*([a-z0-9_.]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/gi, (_, key: string, fallback?: string) => {
		const v = vars[key.toLowerCase()];
		const value = v === undefined || v === null || v === "" ? (fallback ?? "") : String(v);
		return mode === "html" ? escapeHtml(value) : value;
	});
}

/** Rewrites every http(s) href through `rewrite`, except links it returns null for. */
export function rewriteLinks(html: string, rewrite: (url: string) => string | null): string {
	return html.replace(/(<a\s[^>]*?href=")([^"]+)(")/gi, (m, pre: string, href: string, post: string) => {
		const url = href.replace(/&amp;/g, "&");
		if (!/^https?:\/\//i.test(url)) return m;
		const next = rewrite(url);
		return next ? `${pre}${escapeHtml(next)}${post}` : m;
	});
}

/** Collects unique http(s) link targets in document order. */
export function collectLinks(html: string): string[] {
	const seen = new Set<string>();
	for (const m of html.matchAll(/<a\s[^>]*?href="([^"]+)"/gi)) {
		const url = m[1].replace(/&amp;/g, "&");
		if (/^https?:\/\//i.test(url)) seen.add(url);
	}
	return [...seen];
}

export interface LayoutInput {
	config: NewsletterConfig;
	subject: string;
	preheader?: string;
	bodyHtml: string;
	bodyText: string;
	unsubscribeUrl: string;
	preferencesUrl: string;
	webUrl?: string;
	referral?: { url: string; count: number; nextReward?: string; needed?: number };
	/** A sponsor ad, shown after the body. */
	sponsor?: { html: string; text: string };
	/** Short note above the footer, e.g. "You're receiving this because…". */
	reason?: string;
	/** Hide the publication header (transactional emails). */
	compact?: boolean;
}

export function layout(input: LayoutInput): { html: string; text: string } {
	const c = input.config;
	const s = emailStyles(c.brand.accentColor);
	const pub = escapeHtml(c.publicationName);
	const muted = `font:13px/1.5 ${FONT_STACK};color:#6b7079`;
	const pre = input.preheader
		? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${escapeHtml(input.preheader)}${"&#8199;&#65279;&#847; ".repeat(40)}</div>`
		: "";
	const header = input.compact
		? ""
		: `<tr><td style="padding:28px 32px 8px">${
				c.brand.logoUrl
					? `<img src="${escapeHtml(c.brand.logoUrl)}" alt="${pub}" height="32" style="display:block;height:32px;width:auto;border:0">`
					: `<p style="margin:0;font:700 13px/1 ${FONT_STACK};letter-spacing:.08em;text-transform:uppercase;color:${s.accent}">${pub}</p>`
			}${input.webUrl ? `<p style="margin:10px 0 0;${muted}"><a href="${escapeHtml(input.webUrl)}" style="color:#6b7079">Read on the web</a></p>` : ""}</td></tr>`;

	const ref = input.referral;
	const referralBlock = ref
		? `<tr><td style="padding:0 32px 8px"><div style="padding:18px 20px;border-radius:12px;background:#f5f4fd">
<p style="margin:0 0 6px;font:600 15px/1.4 ${FONT_STACK};color:#111318">Share ${pub}${ref.nextReward ? ` and earn ${escapeHtml(ref.nextReward)}` : ""}</p>
<p style="margin:0 0 10px;${muted}">You've referred ${ref.count} ${ref.count === 1 ? "reader" : "readers"}${ref.needed ? `. ${ref.needed} more to go` : ""}. Your link:</p>
<p style="margin:0;font:14px/1.4 ${FONT_STACK};word-break:break-all"><a href="${escapeHtml(ref.url)}" style="${s.link}">${escapeHtml(ref.url)}</a></p></div></td></tr>`
		: "";

	const footerLines = [
		input.reason ? escapeHtml(input.reason) : "",
		c.brand.footerText ? escapeHtml(c.brand.footerText) : "",
		c.postalAddress ? escapeHtml(c.postalAddress) : "",
		`<a href="${escapeHtml(input.preferencesUrl)}" style="color:#6b7079">Manage preferences</a> · <a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#6b7079">Unsubscribe</a>`,
	].filter(Boolean);

	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(input.subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f6;-webkit-text-size-adjust:100%">${pre}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f6"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:16px">
${header}
<tr><td style="padding:16px 32px 16px">${input.bodyHtml}</td></tr>
${input.sponsor ? `<tr><td style="padding:0 32px 16px">${input.sponsor.html}</td></tr>` : ""}
${referralBlock}
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px"><tr><td style="padding:20px 32px;text-align:center;${muted}">${footerLines.join("<br>")}</td></tr></table>
</td></tr></table></body></html>`;

	const textParts = [
		input.compact ? "" : c.publicationName.toUpperCase(),
		input.webUrl ? `Read on the web: ${input.webUrl}` : "",
		input.bodyText,
		input.sponsor ? `----
${input.sponsor.text}` : "",
		ref ? `Share ${c.publicationName}: ${ref.url} (${ref.count} referred${ref.needed ? `, ${ref.needed} more for ${ref.nextReward}` : ""})` : "",
		"----",
		input.reason ?? "",
		c.brand.footerText,
		c.postalAddress,
		`Manage preferences: ${input.preferencesUrl}`,
		`Unsubscribe: ${input.unsubscribeUrl}`,
	];
	return { html, text: textParts.filter(Boolean).join("\n\n") };
}

export { emailStyles };
