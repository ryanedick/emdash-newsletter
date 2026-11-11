/**
 * The public HTTP surface, as one standard `(Request) => Response` function.
 * Mount it on a catch-all route under `publicBasePath` (default /newsletter):
 *
 *   // src/pages/newsletter/[...path].ts (Astro)
 *   export const ALL: APIRoute = ({ request }) => handler(request);
 *
 * Routes (relative to the base path):
 *   POST /subscribe            form or JSON sign-up (honeypot, rate limit, optional Turnstile)
 *   GET  /confirm?t=           double opt-in confirmation
 *   GET  /u?t=                 unsubscribe confirmation page
 *   POST /u?t=                 unsubscribe (also RFC 8058 one-click from mailbox providers)
 *   GET|POST /preferences?t=   preference center (name, topics, resubscribe)
 *   GET  /c/<token>            click tracking redirect
 *   GET  /o/<token>.gif        open tracking pixel
 *   POST /webhooks/<provider>  provider delivery events (bounces, complaints, unsubscribes)
 *   GET  /r/<code>             referral link: remembers the referrer, then goes to the site
 *   GET  /archive, /p/<slug>   public web archive
 */
import type { Subscriber } from "./core.ts";
import type { Newsletter } from "./newsletter.ts";
import { archivePage, defaultShell, messagePage, type PageShell, preferencesPage, unsubscribeConfirmPage } from "./pages.ts";
import { emailStyles, renderBody } from "./render/email.ts";
import { escapeHtml, normalizeEmail, now } from "./util.ts";
import { preferencesUrl, unsubscribeUrl, webIssueUrl } from "./links.ts";
import { publicUrl } from "./core.ts";

export interface HandlerOptions {
	/** Wrap pages in your site's layout. */
	pageShell?: PageShell;
	/** Send people to your own pages instead of the built-in ones. */
	redirects?: { subscribed?: string; confirmed?: string; unsubscribed?: string };
	/**
	 * Runs each time a confirmation link is opened, before the built-in page or
	 * `redirects.confirmed`. Return a Response, or a same-origin URL to redirect to,
	 * to take over; return nothing to keep the default. Use it to hand a new reader
	 * on to your site, e.g. to sign them in to an account.
	 *
	 * `firstConfirmation` is true only for the open that confirmed the address.
	 * Mail scanners often open links before the reader does, so don't start a
	 * session here: send them to a page where they press a button.
	 */
	afterConfirm?: (subscriber: Subscriber, info: AfterConfirmInfo) => Response | string | null | undefined | Promise<Response | string | null | undefined>;
	/** Client IP (defaults to CF-Connecting-IP). */
	clientIp?: (request: Request) => string | null;
	/** Max sign-ups per IP per hour (default 10). */
	ipLimitPerHour?: number;
}

export interface AfterConfirmInfo {
	request: Request;
	/** True only for the open that confirmed the address. */
	firstConfirmation: boolean;
	/** When the confirmation link was created (ms since epoch), if known. */
	sentAt: number | null;
}

const GIF = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (c) => c.charCodeAt(0));
const REF_COOKIE = "nl_ref";

function cookie(request: Request, name: string): string | null {
	const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(request.headers.get("cookie") ?? "");
	return m ? decodeURIComponent(m[1]) : null;
}

function sameOrigin(target: string | null | undefined, base: URL): string | null {
	if (!target) return null;
	try {
		const u = new URL(target, base);
		return u.origin === base.origin ? u.pathname + u.search + u.hash : null;
	} catch {
		return null;
	}
}

async function readBody(request: Request): Promise<Record<string, string | string[]>> {
	const type = request.headers.get("content-type") ?? "";
	if (type.includes("application/json")) {
		const j = (await request.json().catch(() => ({}))) as Record<string, unknown>;
		const out: Record<string, string | string[]> = {};
		for (const [k, v] of Object.entries(j)) out[k] = Array.isArray(v) ? v.map(String) : String(v ?? "");
		return out;
	}
	const form = await request.formData().catch(() => null);
	const out: Record<string, string | string[]> = {};
	if (!form) return out;
	for (const k of new Set(form.keys())) {
		const all = form.getAll(k).map((v) => (typeof v === "string" ? v : ""));
		out[k] = all.length > 1 || k === "topics" ? all : all[0];
	}
	return out;
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export function createNewsletterHandler(nl: Newsletter, options: HandlerOptions = {}) {
	const shell = options.pageShell ?? defaultShell;
	const ipOf = options.clientIp ?? ((r: Request) => r.headers.get("cf-connecting-ip"));

	return async function handle(request: Request): Promise<Response> {
		await nl.ready();
		const config = await nl.settings.get();
		const url = new URL(request.url);
		const base = config.publicBasePath.replace(/\/$/, "");
		if (!url.pathname.startsWith(base)) return new Response("Not found", { status: 404 });
		const path = url.pathname.slice(base.length) || "/";
		const method = request.method.toUpperCase();
		const core = nl.core;

		const html = (title: string, body: string, status = 200, headers: Record<string, string> = {}) =>
			new Response(shell({ title, body, config }), {
				status,
				headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex", ...headers },
			});
		const redirect = (to: string, status = 303, headers: Record<string, string> = {}) => new Response(null, { status, headers: { location: to, "cache-control": "no-store", ...headers } });
		const home = config.siteUrl || url.origin;

		// ─── subscribe ───
		if (path === "/subscribe" && method === "POST") {
			const wantsJson = (request.headers.get("accept") ?? "").includes("application/json") || (request.headers.get("content-type") ?? "").includes("json");
			const reply = (ok: boolean, message: string, status = ok ? 200 : 400, extra: Record<string, unknown> = {}) => {
				if (wantsJson) return Response.json({ ok, message, ...extra }, { status });
				const back = sameOrigin(one(body.redirect), url) ?? options.redirects?.subscribed;
				if (back) {
					const u = new URL(back, url);
					u.searchParams.set("ok", String(ok));
					u.searchParams.set("m", message);
					return redirect(u.pathname + u.search);
				}
				return html(ok ? "Check your inbox" : "Something's not right", messagePage(ok ? "Almost there" : "Something's not right", [escapeHtml(message)], { label: "Back to the site", href: home }), status);
			};
			const body = await readBody(request);
			if (one(body.website).trim() || one(body.company_url).trim()) return reply(true, "Thanks! Check your inbox to confirm.");
			const email = normalizeEmail(one(body.email));
			if (!email) return reply(false, "That email address doesn't look right.");

			const ip = ipOf(request);
			if (ip) {
				const limit = options.ipLimitPerHour ?? 10;
				const window = Math.floor(now() / 3600_000) * 3600_000;
				const row = await core.db
					.prepare(
						`INSERT INTO nl_rate (key, window_start, count) VALUES (?, ?, 1)
						 ON CONFLICT (key) DO UPDATE SET count = CASE WHEN nl_rate.window_start = excluded.window_start THEN nl_rate.count + 1 ELSE 1 END, window_start = excluded.window_start
						 RETURNING count`,
					)
					.bind(`ip:${ip}`, window)
					.first<{ count: number }>();
				if ((row?.count ?? 0) > limit) return reply(false, "Too many sign-ups from your network. Please try again later.", 429);
			}
			if (config.turnstileSecret) {
				const token = one(body["cf-turnstile-response"]);
				const form = new FormData();
				form.set("secret", config.turnstileSecret);
				form.set("response", token);
				if (ip) form.set("remoteip", ip);
				const ok = token
					? await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form })
							.then((r) => r.json() as Promise<{ success?: boolean }>)
							.then((j) => !!j.success)
							.catch(() => false)
					: false;
				if (!ok) return reply(false, "Please complete the verification and try again.", 403);
			}
			const utm: Record<string, string> = {};
			for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]) if (one(body[k])) utm[k] = one(body[k]).slice(0, 100);
			const topics = (Array.isArray(body.topics) ? body.topics : body.topics ? [body.topics] : []).filter(Boolean);
			const res = await nl.subscribers.subscribe({
				email,
				firstName: one(body.first_name) || one(body.name) || undefined,
				lastName: one(body.last_name) || undefined,
				source: one(body.source) || "website",
				utm: Object.keys(utm).length ? utm : undefined,
				ref: one(body.ref) || cookie(request, REF_COOKIE) || undefined,
				topics: topics.length ? topics : undefined,
				ip,
			});
			if (res.status === "invalid_email") return reply(false, "That email address doesn't look right.");
			if (res.status === "pending") return reply(true, "Check your inbox and tap the link to confirm your subscription.", 200, { status: "pending" });
			if (res.status === "already_active") return reply(true, "You're already subscribed. Thanks for reading!", 200, { status: "active" });
			return reply(true, "You're subscribed!", 200, { status: "active" });
		}

		// ─── confirm ───
		if (path === "/confirm" && method === "GET") {
			const result = await nl.subscribers.confirmToken(url.searchParams.get("t"));
			const sub = result?.subscriber ?? null;
			if (!sub) return html("Link expired", messagePage("This link has expired", ["Confirmation links last 7 days. Sign up again and we'll send a fresh one."], { label: "Back to the site", href: home }), 400);
			if (options.afterConfirm && result) {
				try {
					const out = await options.afterConfirm(sub, { request, firstConfirmation: result.firstConfirmation, sentAt: result.sentAt });
					if (out instanceof Response) return out;
					const to = typeof out === "string" ? sameOrigin(out, url) : null;
					if (to) return redirect(to);
				} catch (err) {
					core.log.error("afterConfirm hook failed", { error: String(err) });
				}
			}
			if (options.redirects?.confirmed) return redirect(options.redirects.confirmed);
			return html("You're in", messagePage("You're subscribed", [`Thanks for confirming, ${escapeHtml(sub.firstName ?? sub.email)}. Your first issue of ${escapeHtml(config.publicationName)} is on its way.`], { label: "Visit the site", href: home }));
		}

		// ─── unsubscribe ───
		if (path === "/u") {
			const token = url.searchParams.get("t");
			const data = await core.signer.verify<{ s: string; c?: string }>("unsub", token);
			if (!data) return html("Invalid link", messagePage("This link isn't valid", ["It may have been cut off by your email app. Use the link from a more recent email."]), 400);
			if (method === "POST") {
				const raw = await request.text().catch(() => "");
				const oneClick = raw.includes("List-Unsubscribe=One-Click");
				const sub = await nl.subscribers.unsubscribe(data.s, oneClick ? "one_click" : "link", data.c ?? null);
				if (oneClick) return new Response("Unsubscribed", { status: 200, headers: { "content-type": "text/plain" } });
				if (options.redirects?.unsubscribed) return redirect(options.redirects.unsubscribed);
				const prefs = sub ? await preferencesUrl(core, config, sub.id) : home;
				return html("Unsubscribed", messagePage("You're unsubscribed", [`You won't get any more emails from ${escapeHtml(config.publicationName)}${sub ? ` at ${escapeHtml(sub.email)}` : ""}.`, `Changed your mind? <a href="${escapeHtml(prefs)}">Resubscribe here</a>.`]));
			}
			const sub = await nl.subscribers.getSubscriber(data.s);
			if (!sub) return html("Unsubscribed", messagePage("You're not on the list", ["This address isn't subscribed anymore."]));
			if (sub.status !== "active" && sub.status !== "pending") {
				return html("Unsubscribed", messagePage("You're already unsubscribed", [`${escapeHtml(sub.email)} won't receive any more emails.`]));
			}
			return html("Unsubscribe", unsubscribeConfirmPage(sub.email, `${base}/u?t=${encodeURIComponent(token ?? "")}`, await preferencesUrl(core, config, sub.id)));
		}

		// ─── preferences ───
		if (path === "/preferences") {
			const token = url.searchParams.get("t");
			const data = await core.signer.verify<{ s: string }>("prefs", token);
			const sub = data ? await nl.subscribers.getSubscriber(data.s, true) : null;
			if (!sub) return html("Invalid link", messagePage("This link isn't valid", ["Use the “Manage preferences” link from a recent email."]), 400);
			const topics = await nl.subscribers.listTopics(true);
			const action = `${base}/preferences?t=${encodeURIComponent(token ?? "")}`;
			if (method === "POST") {
				const body = await readBody(request);
				const chosen = Array.isArray(body.topics) ? body.topics : body.topics ? [body.topics] : [];
				let updated = await nl.subscribers.updatePreferences(sub.id, { firstName: one(body.first_name), lastName: one(body.last_name), topics: topics.length ? chosen : undefined });
				if (one(body.resubscribe) && sub.status !== "active") {
					// Resubscribing from a signed link proves ownership, but complaints need a fresh opt-in.
					if (sub.status === "complained") await nl.subscribers.subscribe({ email: sub.email, source: "preferences", ip: ipOf(request) });
					else await nl.subscribers.activate(sub.id);
					updated = await nl.subscribers.getSubscriber(sub.id, true);
				}
				return html("Preferences", preferencesPage(updated ?? sub, topics, action, await unsubscribeUrl(core, config, sub.id), true));
			}
			return html("Preferences", preferencesPage(sub, topics, action, await unsubscribeUrl(core, config, sub.id), false));
		}

		// ─── tracking ───
		if (path.startsWith("/c/") && method === "GET") {
			const target = await nl.events.recordClick(path.slice(3), { userAgent: request.headers.get("user-agent") });
			return redirect(target ?? home, 302);
		}
		if (path.startsWith("/o/") && (method === "GET" || method === "HEAD")) {
			await nl.events.recordOpen(path.slice(3), { userAgent: request.headers.get("user-agent") }).catch(() => false);
			return new Response(GIF, { headers: { "content-type": "image/gif", "cache-control": "no-store, max-age=0" } });
		}

		// ─── provider webhooks ───
		if (path.startsWith("/webhooks/") && method === "POST") {
			const provider = path.slice("/webhooks/".length).replace(/[^a-z0-9-]/gi, "");
			const body = await request.text();
			if (body.length > 2_000_000) return Response.json({ ok: false, error: "too large" }, { status: 413 });
			const out = await nl.events.handleWebhook({ provider, body, headers: request.headers, url });
			if (!out.ok) return Response.json(out, { status: out.status });
			return Response.json(out);
		}

		// ─── referrals ───
		if (path.startsWith("/r/") && method === "GET") {
			const code = decodeURIComponent(path.slice(3)).replace(/[^a-z0-9]/gi, "").slice(0, 40);
			const to = sameOrigin(url.searchParams.get("to"), url) ?? home;
			return redirect(to, 302, code ? { "set-cookie": `${REF_COOKIE}=${code}; Path=/; Max-Age=2592000; SameSite=Lax; Secure; HttpOnly` } : {});
		}

		// ─── web archive ───
		if ((path === "/archive" || path === "/") && method === "GET") {
			const page = Math.max(0, Number(url.searchParams.get("page") ?? 0) || 0);
			const issues = await nl.campaigns.listArchive(30, page * 30);
			return html("Past issues", archivePage(issues, (c) => `${base}/p/${encodeURIComponent(c.webSlug ?? c.id)}`), 200, { "cache-control": "public, max-age=300" });
		}
		if (path.startsWith("/p/") && method === "GET") {
			const slug = decodeURIComponent(path.slice(3));
			const c = await nl.campaigns.getCampaignBySlug(slug);
			if (!c || !c.publishWeb || !["sending", "sent"].includes(c.status)) return html("Not found", messagePage("Issue not found", ["It may have been removed."]), 404);
			const allowed = c.webAccess === "public" || (core.hooks.canViewArchive ? await core.hooks.canViewArchive(request, { id: c.id, webAccess: c.webAccess }) : false);
			const date = new Date(c.sentAt ?? c.startedAt ?? c.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
			const subscribeForm = `<hr style="border:0;border-top:1px solid var(--border);margin:28px 0"><form method="post" action="${base}/subscribe"><p><strong>Get the next issue by email</strong></p><div class="row"><label style="flex:1;margin:0"><span class="muted">Email</span><input type="email" name="email" required autocomplete="email"></label><input type="hidden" name="source" value="archive"><button type="submit">Subscribe</button></div></form>`;
			if (!allowed) {
				return html(c.subject, `<h1>${escapeHtml(c.subject)}</h1><p class="muted">${date}</p>${c.preheader ? `<p>${escapeHtml(c.preheader)}</p>` : ""}<p><strong>This issue is for members.</strong></p>${subscribeForm}`, 200);
			}
			const body = renderBody(c.contentFormat, c.content, emailStyles(config.brand.accentColor), { baseUrl: config.siteUrl });
			// Merge tags have no reader here: drop them to their fallbacks.
			const content = body.html.replace(/\{\{\s*[a-z0-9_.]+\s*(?:\|\s*([^}]*?)\s*)?\}\}/gi, (_, f) => escapeHtml(f ?? ""));
			return html(c.subject, `<p class="muted">${date}</p><div class="issue">${content}</div>${subscribeForm}`, 200, {
				"cache-control": c.webAccess === "public" ? "public, max-age=300" : "private, no-store",
				link: `<${webIssueUrl(config, c.webSlug ?? c.id)}>; rel="canonical"`,
			});
		}

		if (path === "/health") return Response.json({ ok: true, base: publicUrl(config, "/") });
		return html("Not found", messagePage("Not found", ["That page doesn't exist."]), 404);
	};
}
