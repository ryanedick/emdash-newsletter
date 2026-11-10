/**
 * Small, safe Markdown → email HTML renderer for the campaign composer.
 * Raw HTML in the source is escaped. Supported:
 *   # / ## / ### headings, paragraphs, **bold**, *italic*, `code`, ~~strike~~,
 *   [link](url), ![alt](image-url), - / * / 1. lists, > quotes, --- rules,
 *   ``` fenced code, and buttons: [[Button label]](https://url)
 */
import { escapeHtml } from "../util.ts";
import { type EmailStyles, safeUrl } from "./styles.ts";

function inline(src: string, s: EmailStyles): string {
	let out = escapeHtml(src);
	// Images before links. URLs were escaped above, so unescape &amp; inside them.
	out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => {
		const u = safeUrl(url.replace(/&amp;/g, "&"));
		return u ? `<img src="${escapeHtml(u)}" alt="${alt}" style="${s.img}">` : "";
	});
	out = out.replace(/\[\[([^\]]+)\]\]\(([^)\s]+)\)/g, (_, label, url) => {
		const u = safeUrl(url.replace(/&amp;/g, "&"));
		return u ? `<a href="${escapeHtml(u)}" style="${s.button}">${label}</a>` : label;
	});
	out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
		const u = safeUrl(url.replace(/&amp;/g, "&"));
		return u ? `<a href="${escapeHtml(u)}" style="${s.link}">${text}</a>` : text;
	});
	out = out.replace(/`([^`]+)`/g, `<code style="${s.code}">$1</code>`);
	out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>");
	out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>").replace(/(^|\W)_([^_\s][^_]*)_(?=\W|$)/g, "$1<em>$2</em>");
	out = out.replace(/~~([^~]+)~~/g, "<s>$1</s>");
	// Bare URLs
	out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, url) => `${pre}<a href="${url}" style="${s.link}">${url}</a>`);
	return out;
}

export function markdownToHtml(md: string, s: EmailStyles): string {
	const lines = md.replace(/\r\n?/g, "\n").split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (/^\s*$/.test(line)) {
			i++;
			continue;
		}
		const fence = /^```(\w*)\s*$/.exec(line);
		if (fence) {
			const body: string[] = [];
			i++;
			while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
			i++;
			out.push(`<pre style="${s.pre}">${escapeHtml(body.join("\n"))}</pre>`);
			continue;
		}
		const h = /^(#{1,4})\s+(.*)$/.exec(line);
		if (h) {
			const level = h[1].length;
			out.push(`<h${level} style="${s.heading(level)}">${inline(h[2], s)}</h${level}>`);
			i++;
			continue;
		}
		if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
			out.push(`<hr style="${s.hr}">`);
			i++;
			continue;
		}
		if (/^>\s?/.test(line)) {
			const body: string[] = [];
			while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ""));
			out.push(`<blockquote style="${s.quote}">${inline(body.join(" "), s)}</blockquote>`);
			continue;
		}
		const ul = /^\s*[-*+]\s+/;
		const ol = /^\s*\d+[.)]\s+/;
		if (ul.test(line) || ol.test(line)) {
			const ordered = ol.test(line);
			const re = ordered ? ol : ul;
			const items: string[] = [];
			while (i < lines.length && re.test(lines[i])) {
				let item = lines[i++].replace(re, "");
				while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !re.test(lines[i])) item += ` ${lines[i++].trim()}`;
				items.push(`<li style="${s.li}">${inline(item, s)}</li>`);
			}
			const tag = ordered ? "ol" : "ul";
			out.push(`<${tag} style="${s.list}">${items.join("")}</${tag}>`);
			continue;
		}
		const para: string[] = [];
		while (
			i < lines.length &&
			!/^\s*$/.test(lines[i]) &&
			!/^(#{1,4})\s|^```|^>|^\s*[-*+]\s+|^\s*\d+[.)]\s+/.test(lines[i])
		) {
			para.push(lines[i++]);
		}
		const text = para.join("\n");
		// A paragraph that is only a button or image renders without <p> spacing quirks.
		out.push(`<p style="${s.p}">${inline(text, s).replace(/\n/g, "<br>")}</p>`);
	}
	return out.join("\n");
}

/** Plain-text version of Markdown: keeps structure, turns links into "text (url)". */
export function markdownToText(md: string): string {
	return md
		.replace(/\r\n?/g, "\n")
		.replace(/^```\w*\s*$/gm, "")
		.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
		.replace(/\[\[([^\]]+)\]\]\(([^)\s]+)\)/g, "$1: $2")
		.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1$2")
		.replace(/~~([^~]+)~~/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/^#{1,4}\s+(.*)$/gm, (_, t: string) => t.toUpperCase())
		.replace(/^>\s?/gm, "  ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
