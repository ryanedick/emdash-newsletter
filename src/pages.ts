/**
 * Minimal, accessible HTML for the public pages (confirm, unsubscribe,
 * preferences, archive). Sites can wrap them in their own design with the
 * `pageShell` handler option, or replace them with their own pages entirely.
 */
import type { Campaign } from "./campaigns.ts";
import type { Subscriber } from "./core.ts";
import type { NewsletterConfig } from "./settings.ts";
import type { Topic } from "./subscribers.ts";
import { escapeHtml } from "./util.ts";

export interface PageShellInput {
	title: string;
	/** Inner HTML (already escaped where needed). */
	body: string;
	config: NewsletterConfig;
}

export type PageShell = (input: PageShellInput) => string;

export const defaultShell: PageShell = ({ title, body, config }) => {
	const accent = /^#[0-9a-f]{3,8}$/i.test(config.brand.accentColor) ? config.brand.accentColor : "#4f3cc9";
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)} · ${escapeHtml(config.publicationName)}</title>
<style>
:root{--accent:${accent};--bg:#f6f6f4;--card:#fff;--text:#18181b;--muted:#6b7079;--border:#e4e4e7}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--card:#1c1c1f;--text:#f4f4f5;--muted:#a1a1aa;--border:#2e2e33}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif}
main{max-width:640px;margin:0 auto;padding:48px 16px}.card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:32px}
h1{margin:0 0 12px;font-size:1.6rem;line-height:1.25}p{margin:0 0 14px}.muted{color:var(--muted);font-size:.92rem}
a{color:var(--accent)}.brand{margin:0 0 20px;font:700 12px/1 ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
button,.btn{display:inline-block;font:inherit;font-weight:600;border:0;border-radius:999px;padding:11px 20px;background:var(--accent);color:#fff;cursor:pointer;text-decoration:none}
button.secondary{background:transparent;color:var(--text);border:1px solid var(--border)}
label{display:block;margin:0 0 12px}input[type=text],input[type=email]{width:100%;font:inherit;padding:10px 12px;border-radius:10px;border:1px solid var(--border);background:var(--bg);color:var(--text)}
fieldset{border:1px solid var(--border);border-radius:12px;padding:12px 16px;margin:0 0 16px}legend{padding:0 6px;font-weight:600}
.check{display:flex;gap:10px;align-items:flex-start}.check input{margin-top:5px}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
ul.issues{list-style:none;padding:0;margin:0}ul.issues li{padding:14px 0;border-top:1px solid var(--border)}ul.issues li:first-child{border-top:0}
.issue img{max-width:100%;height:auto}
</style></head><body><main><div class="card"><p class="brand">${escapeHtml(config.publicationName)}</p>${body}</div></main></body></html>`;
};

export function messagePage(title: string, paragraphs: string[], cta?: { label: string; href: string }): string {
	return `<h1>${escapeHtml(title)}</h1>${paragraphs.map((p) => `<p>${p}</p>`).join("")}${cta ? `<p><a class="btn" href="${escapeHtml(cta.href)}">${escapeHtml(cta.label)}</a></p>` : ""}`;
}

export function unsubscribeConfirmPage(email: string, action: string, prefsHref: string): string {
	return `<h1>Unsubscribe?</h1><p>You'll stop receiving emails at <strong>${escapeHtml(email)}</strong>.</p>
<form method="post" action="${escapeHtml(action)}"><div class="row"><button type="submit">Unsubscribe</button>
<a href="${escapeHtml(prefsHref)}">Change what I get instead</a></div></form>`;
}

export function preferencesPage(sub: Subscriber, topics: Topic[], action: string, unsubHref: string, saved: boolean): string {
	const tags = new Set(sub.tags ?? []);
	const topicBoxes = topics.length
		? `<fieldset><legend>What you get</legend>${topics
				.map(
					(t) =>
						`<label class="check"><input type="checkbox" name="topics" value="${escapeHtml(t.slug)}"${tags.has(`topic:${t.slug}`) ? " checked" : ""}><span><strong>${escapeHtml(t.name)}</strong>${t.description ? `<br><span class="muted">${escapeHtml(t.description)}</span>` : ""}</span></label>`,
				)
				.join("")}</fieldset>`
		: "";
	const status =
		sub.status === "active"
			? ""
			: `<p class="muted">You're currently <strong>${escapeHtml(sub.status)}</strong>. Saving with “Resubscribe” checked starts your emails again.</p>
<label class="check"><input type="checkbox" name="resubscribe" value="1"><span>Resubscribe</span></label>`;
	return `<h1>Email preferences</h1>${saved ? `<p role="status"><strong>Saved.</strong></p>` : ""}
<p class="muted">For ${escapeHtml(sub.email)}</p>
<form method="post" action="${escapeHtml(action)}">
<label>First name<input type="text" name="first_name" value="${escapeHtml(sub.firstName ?? "")}" autocomplete="given-name"></label>
<label>Last name<input type="text" name="last_name" value="${escapeHtml(sub.lastName ?? "")}" autocomplete="family-name"></label>
${topicBoxes}${status}
<div class="row"><button type="submit">Save preferences</button>${sub.status === "active" ? `<a href="${escapeHtml(unsubHref)}">Unsubscribe from everything</a>` : ""}</div>
</form>`;
}

export function archivePage(issues: Campaign[], issueHref: (c: Campaign) => string): string {
	if (!issues.length) return `<h1>Past issues</h1><p class="muted">Nothing here yet.</p>`;
	return `<h1>Past issues</h1><ul class="issues">${issues
		.map(
			(c) =>
				`<li><a href="${escapeHtml(issueHref(c))}"><strong>${escapeHtml(c.subject)}</strong></a><br><span class="muted">${new Date(c.sentAt ?? c.startedAt ?? c.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}${c.webAccess === "members" ? " · Members" : ""}</span></li>`,
		)
		.join("")}</ul>`;
}
