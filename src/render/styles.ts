/** Inline styles shared by the Markdown and Portable Text renderers (email clients ignore <style> often). */
export interface EmailStyles {
	accent: string;
	p: string;
	heading(level: number): string;
	link: string;
	button: string;
	img: string;
	code: string;
	pre: string;
	quote: string;
	list: string;
	li: string;
	hr: string;
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Helvetica,Arial,sans-serif";
export const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

export function emailStyles(accent = "#4f3cc9"): EmailStyles {
	const a = /^#[0-9a-f]{3,8}$/i.test(accent) ? accent : "#4f3cc9";
	return {
		accent: a,
		p: `margin:0 0 16px;font:16px/1.6 ${FONT};color:#1f2328`,
		heading: (l) => `margin:${l <= 2 ? "28px" : "22px"} 0 12px;font:700 ${[0, 26, 21, 18, 16][l] ?? 16}px/1.3 ${FONT};color:#111318`,
		link: `color:${a};text-decoration:underline`,
		button: `display:inline-block;padding:12px 22px;border-radius:999px;background:${a};color:#ffffff;text-decoration:none;font:600 15px/1.2 ${FONT}`,
		img: "display:block;max-width:100%;height:auto;border:0;border-radius:8px;margin:0 0 16px",
		code: `font:14px/1.4 ${MONO};background:#f2f2f5;padding:2px 5px;border-radius:4px`,
		pre: `margin:0 0 16px;padding:14px 16px;background:#f5f5f8;border-radius:8px;font:13px/1.5 ${MONO};white-space:pre-wrap;word-break:break-word;color:#1f2328`,
		quote: `margin:0 0 16px;padding:4px 0 4px 16px;border-left:3px solid ${a};font:italic 16px/1.6 ${FONT};color:#3d424a`,
		list: `margin:0 0 16px;padding-left:24px;font:16px/1.6 ${FONT};color:#1f2328`,
		li: "margin:0 0 6px",
		hr: "border:0;border-top:1px solid #e5e5ea;margin:24px 0",
	};
}

/** Allows http(s), mailto and tel links and merge-tag URLs; anything else is dropped. */
export function safeUrl(url: string): string | null {
	const u = url.trim();
	if (/^\{\{\s*[a-z_.]+\s*\}\}$/i.test(u)) return u;
	if (/^(https?:|mailto:|tel:)/i.test(u)) return u;
	if (u.startsWith("/") && !u.startsWith("//")) return u;
	return null;
}

export const FONT_STACK = FONT;
