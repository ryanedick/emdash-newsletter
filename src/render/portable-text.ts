/**
 * Portable Text → email HTML. Covers the standard block set (styles, lists,
 * marks, links, images, code) plus a hook for custom block types, so EmDash
 * content can be sent as a newsletter as-is.
 */
import { escapeHtml } from "../util.ts";
import { type EmailStyles, safeUrl } from "./styles.ts";

export interface PtSpan {
	_type: "span";
	text: string;
	marks?: string[];
}

export interface PtBlock {
	_type: string;
	_key?: string;
	style?: string;
	listItem?: "bullet" | "number" | string;
	level?: number;
	children?: PtSpan[];
	markDefs?: { _key: string; _type: string; href?: string; [k: string]: unknown }[];
	[k: string]: unknown;
}

/** Return HTML for a custom block type, or undefined to skip it. */
export type PtBlockRenderer = (block: PtBlock, styles: EmailStyles) => string | undefined;

export interface PtOptions {
	/** Make relative URLs absolute. */
	baseUrl?: string;
	/** Custom block renderers keyed by `_type`. */
	blocks?: Record<string, PtBlockRenderer>;
	/** Resolves an image block to a URL (EmDash image fields vary by storage). */
	imageUrl?: (block: PtBlock) => string | undefined;
}

function absolute(url: string, base?: string): string {
	if (!base || !url.startsWith("/") || url.startsWith("//")) return url;
	return base.replace(/\/$/, "") + url;
}

function spans(block: PtBlock, s: EmailStyles, opts: PtOptions): string {
	const defs = new Map((block.markDefs ?? []).map((d) => [d._key, d]));
	return (block.children ?? [])
		.map((child) => {
			if (child._type !== "span") return "";
			let html = escapeHtml(child.text ?? "").replace(/\n/g, "<br>");
			// Decorators first so links (annotations) wrap them.
			const decorators = new Set(["strong", "em", "code", "underline", "strike-through"]);
			const marks = [...(child.marks ?? [])].sort((a, b) => Number(!decorators.has(a)) - Number(!decorators.has(b)));
			for (const mark of marks) {
				if (mark === "strong") html = `<strong>${html}</strong>`;
				else if (mark === "em") html = `<em>${html}</em>`;
				else if (mark === "code") html = `<code style="${s.code}">${html}</code>`;
				else if (mark === "underline") html = `<u>${html}</u>`;
				else if (mark === "strike-through") html = `<s>${html}</s>`;
				else {
					const def = defs.get(mark);
					if (def?._type === "link" && typeof def.href === "string") {
						const u = safeUrl(absolute(def.href, opts.baseUrl));
						if (u) html = `<a href="${escapeHtml(u)}" style="${s.link}">${html}</a>`;
					}
				}
			}
			return html;
		})
		.join("");
}

function defaultImageUrl(block: PtBlock): string | undefined {
	const asset = block.asset as { url?: string; src?: string } | undefined;
	return (block.url as string) ?? (block.src as string) ?? asset?.url ?? asset?.src;
}

export function portableTextToHtml(value: unknown, s: EmailStyles, opts: PtOptions = {}): string {
	if (!Array.isArray(value)) return "";
	const blocks = value as PtBlock[];
	const out: string[] = [];
	let i = 0;
	while (i < blocks.length) {
		const b = blocks[i];
		if (b._type === "block" && b.listItem) {
			// Group consecutive list items (flattening nesting to indentation).
			const ordered = b.listItem === "number";
			const items: string[] = [];
			while (i < blocks.length && blocks[i]._type === "block" && blocks[i].listItem === b.listItem) {
				const item = blocks[i];
				const indent = Math.max(0, (item.level ?? 1) - 1) * 18;
				items.push(`<li style="${s.li}${indent ? `;margin-left:${indent}px` : ""}">${spans(item, s, opts)}</li>`);
				i++;
			}
			const tag = ordered ? "ol" : "ul";
			out.push(`<${tag} style="${s.list}">${items.join("")}</${tag}>`);
			continue;
		}
		i++;
		if (b._type === "block") {
			const content = spans(b, s, opts);
			const style = b.style ?? "normal";
			const h = /^h([1-6])$/.exec(style);
			if (h) out.push(`<h${h[1]} style="${s.heading(Number(h[1]))}">${content}</h${h[1]}>`);
			else if (style === "blockquote") out.push(`<blockquote style="${s.quote}">${content}</blockquote>`);
			else if (content.trim()) out.push(`<p style="${s.p}">${content}</p>`);
			continue;
		}
		const custom = opts.blocks?.[b._type];
		if (custom) {
			const html = custom(b, s);
			if (html) out.push(html);
			continue;
		}
		if (b._type === "image") {
			const url = (opts.imageUrl ?? defaultImageUrl)(b);
			const u = url ? safeUrl(absolute(url, opts.baseUrl)) : null;
			if (u) out.push(`<img src="${escapeHtml(u)}" alt="${escapeHtml(String(b.alt ?? ""))}" style="${s.img}">`);
			continue;
		}
		if (b._type === "code" && typeof b.code === "string") {
			out.push(`<pre style="${s.pre}">${escapeHtml(b.code)}</pre>`);
			continue;
		}
		if (b._type === "button" && typeof b.url === "string") {
			const u = safeUrl(absolute(b.url, opts.baseUrl));
			if (u) out.push(`<p style="${s.p}"><a href="${escapeHtml(u)}" style="${s.button}">${escapeHtml(String(b.label ?? "Read more"))}</a></p>`);
			continue;
		}
		if (b._type === "callout" && typeof b.text === "string") {
			out.push(
				`<div style="margin:0 0 16px;padding:14px 16px;border-radius:10px;background:#f5f4fd">${b.title ? `<p style="${s.p};margin-bottom:6px"><strong>${escapeHtml(String(b.title))}</strong></p>` : ""}<pre style="${s.pre};margin:0;background:#ffffff">${escapeHtml(b.text)}</pre></div>`,
			);
			continue;
		}
		if (b._type === "break" || b._type === "divider") out.push(`<hr style="${s.hr}">`);
	}
	return out.join("\n");
}
