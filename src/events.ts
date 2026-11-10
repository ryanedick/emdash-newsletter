/**
 * Engagement and delivery events.
 *
 * - Our own open pixel and click redirects (provider-independent analytics).
 * - Provider webhooks normalised to one event shape. Bounces, complaints and
 *   provider-side unsubscribes update the subscriber so our list and the
 *   provider's suppression list never drift.
 */
import type { Core } from "./core.ts";
import { hex, hmacSha256, timingSafeEqual } from "./crypto.ts";
import { getSubscriberByEmail, unsubscribe } from "./subscribers.ts";
import { b64, normalizeEmail, now } from "./util.ts";

// ───────────────────────────────── tracking ─────────────────────────────────

async function outboxFor(core: Core, id: string) {
	return core.db
		.prepare(`SELECT id, campaign_id, automation_id, step, subscriber_id, variant FROM nl_outbox WHERE id = ?`)
		.bind(id)
		.first<{ id: string; campaign_id: string | null; automation_id: string | null; step: number | null; subscriber_id: string | null; variant: string | null }>();
}

export async function recordOpen(core: Core, token: string, meta: { userAgent?: string | null } = {}): Promise<boolean> {
	const m = /^([A-Za-z0-9_]+)\.([A-Za-z0-9_-]+)(?:\.gif)?$/.exec(token);
	if (!m || !(await core.signer.checkMac("track", m[1], m[2]))) return false;
	const ob = await outboxFor(core, m[1]);
	if (!ob) return false;
	const t = now();
	await core.db.batch([
		core.db
			.prepare(
				`INSERT INTO nl_events (type, outbox_id, campaign_id, subscriber_id, variant, meta, created_at)
				 SELECT 'open', ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM nl_events WHERE outbox_id = ? AND type = 'open' AND created_at > ?)`,
			)
			.bind(ob.id, ob.campaign_id, ob.subscriber_id, ob.variant, meta.userAgent ? JSON.stringify({ ua: meta.userAgent.slice(0, 200) }) : null, t, ob.id, t - 3600_000),
		core.db.prepare(`UPDATE nl_subscribers SET last_open_at = ? WHERE id = ?`).bind(t, ob.subscriber_id),
	]);
	return true;
}

/** Returns the destination URL for a click token (recording the click), or null. */
export async function recordClick(core: Core, token: string, meta: { userAgent?: string | null } = {}): Promise<string | null> {
	const m = /^([A-Za-z0-9_]+)\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(token);
	if (!m) return null;
	const [, outboxId, linkIdS, mac] = m;
	const linkId = Number(linkIdS);
	const link = await core.db.prepare(`SELECT scope, url FROM nl_links WHERE id = ?`).bind(linkId).first<{ scope: string; url: string }>();
	if (!link) return null;
	if (!(await core.signer.checkMac("track", outboxId, mac))) {
		// Tampered or truncated token: still take the reader where the link points, record nothing.
		return link.url;
	}
	const ob = await outboxFor(core, outboxId);
	const expectedScope = ob?.campaign_id ? `c:${ob.campaign_id}` : ob?.automation_id ? `a:${ob.automation_id}:${ob.step}` : null;
	if (!ob || link.scope !== expectedScope) return link.url;
	const t = now();
	await core.db.batch([
		core.db
			.prepare(`INSERT INTO nl_events (type, outbox_id, campaign_id, subscriber_id, link_id, variant, meta, created_at) VALUES ('click', ?, ?, ?, ?, ?, ?, ?)`)
			.bind(ob.id, ob.campaign_id, ob.subscriber_id, linkId, ob.variant, meta.userAgent ? JSON.stringify({ ua: meta.userAgent.slice(0, 200) }) : null, t),
		// A click implies an open (image blocking hides real opens).
		core.db
			.prepare(
				`INSERT INTO nl_events (type, outbox_id, campaign_id, subscriber_id, variant, created_at)
				 SELECT 'open', ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM nl_events WHERE outbox_id = ? AND type = 'open')`,
			)
			.bind(ob.id, ob.campaign_id, ob.subscriber_id, ob.variant, t, ob.id),
		core.db.prepare(`UPDATE nl_subscribers SET last_click_at = ?, last_open_at = COALESCE(last_open_at, ?) WHERE id = ?`).bind(t, t, ob.subscriber_id),
	]);
	return link.url;
}

// ─────────────────────────────── provider webhooks ───────────────────────────────

export type DeliveryEventType = "delivered" | "bounced" | "soft_bounce" | "complained" | "unsubscribed" | "suppressed" | "deferred";

export interface DeliveryEvent {
	type: DeliveryEventType;
	email?: string;
	outboxId?: string;
	providerMessageId?: string;
	/** Provider event id, for de-duplication. */
	eventId?: string;
	detail?: string;
}

export interface WebhookInput {
	provider: string;
	body: string;
	headers: Headers;
	url: URL;
}

export type WebhookOutcome = { ok: true; processed: number; ignored: number } | { ok: false; status: number; error: string };

/** Standard Webhooks (Bird) / Svix (Resend): HMAC-SHA256 over `${id}.${timestamp}.${body}`. */
export async function verifyStandardWebhook(secret: string, headers: Headers, body: string, toleranceSec = 300): Promise<boolean> {
	const id = headers.get("webhook-id") ?? headers.get("svix-id");
	const ts = headers.get("webhook-timestamp") ?? headers.get("svix-timestamp");
	const sigs = headers.get("webhook-signature") ?? headers.get("svix-signature");
	if (!id || !ts || !sigs) return false;
	if (Math.abs(Date.now() / 1000 - Number(ts)) > toleranceSec) return false;
	const key = secret.startsWith("whsec_") ? b64.decode(secret.slice(6)) : new TextEncoder().encode(secret);
	const expected = b64.encode(await hmacSha256(key, `${id}.${ts}.${body}`));
	return sigs.split(" ").some((s) => {
		const [, sig] = s.split(",");
		return !!sig && timingSafeEqual(sig, expected);
	});
}

const arr = <T>(v: T | T[] | undefined | null): T[] => (Array.isArray(v) ? v : v ? [v] : []);

function parseBird(body: unknown): DeliveryEvent[] {
	const out: DeliveryEvent[] = [];
	for (const e of arr(body as Record<string, unknown> | Record<string, unknown>[])) {
		const type = String(e.type ?? "");
		const d = (e.data ?? {}) as Record<string, unknown>;
		const meta = (d.metadata ?? {}) as Record<string, string>;
		const base = { email: (d.recipient ?? d.email) as string | undefined, outboxId: meta.nl_outbox_id, providerMessageId: d.email_id as string | undefined };
		if (type === "email.delivered") out.push({ ...base, type: "delivered" });
		else if (type === "email.bounced" || type === "email.out_of_band_bounce")
			out.push({ ...base, type: d.bounce_type === "hard" ? "bounced" : "soft_bounce", detail: String(d.bounce_description ?? d.bounce_type ?? "") });
		else if (type === "email.complained") out.push({ ...base, type: "complained" });
		else if (type === "email.unsubscribed" || type === "email.list_unsubscribed") out.push({ ...base, type: "unsubscribed" });
		else if (type === "email.rejected" && d.rejection_reason === "recipient_suppressed") out.push({ ...base, type: "suppressed" });
		else if (type === "email.deferred") out.push({ ...base, type: "deferred" });
		else if (type === "email_suppression.created")
			out.push({ email: d.email as string, type: d.reason === "complaint" ? "complained" : d.reason === "hard_bounce" ? "bounced" : "suppressed" });
	}
	return out;
}

function parseResend(body: unknown): DeliveryEvent[] {
	const e = body as { type?: string; data?: Record<string, unknown> };
	const d = e.data ?? {};
	const tags = d.tags as Record<string, string> | { name: string; value: string }[] | undefined;
	const outboxId = Array.isArray(tags) ? tags.find((t) => t.name === "nl_outbox_id")?.value : tags?.nl_outbox_id;
	const base = { email: arr(d.to as string | string[])[0], outboxId, providerMessageId: d.email_id as string };
	switch (e.type) {
		case "email.delivered":
			return [{ ...base, type: "delivered" }];
		case "email.bounced":
			return [{ ...base, type: (d.bounce as { type?: string })?.type === "Permanent" ? "bounced" : "soft_bounce" }];
		case "email.complained":
			return [{ ...base, type: "complained" }];
		case "email.delivery_delayed":
			return [{ ...base, type: "deferred" }];
		default:
			return [];
	}
}

function parseMailgun(body: unknown): DeliveryEvent[] {
	const d = ((body as Record<string, unknown>)["event-data"] ?? {}) as Record<string, unknown>;
	const vars = (d["user-variables"] ?? {}) as Record<string, string>;
	const msgId = ((d.message as Record<string, unknown>)?.headers as Record<string, string>)?.["message-id"];
	const base = { email: d.recipient as string, outboxId: vars.nl_outbox_id, providerMessageId: msgId, eventId: d.id as string };
	switch (d.event) {
		case "delivered":
			return [{ ...base, type: "delivered" }];
		case "failed":
			return [{ ...base, type: d.severity === "permanent" ? "bounced" : "soft_bounce", detail: String((d["delivery-status"] as { description?: string })?.description ?? "") }];
		case "complained":
			return [{ ...base, type: "complained" }];
		case "unsubscribed":
			return [{ ...base, type: "unsubscribed" }];
		default:
			return [];
	}
}

function parsePostmark(body: unknown): DeliveryEvent[] {
	const e = body as Record<string, unknown>;
	const meta = (e.Metadata ?? {}) as Record<string, string>;
	const base = { email: (e.Email ?? e.Recipient) as string, outboxId: meta.nl_outbox_id, providerMessageId: e.MessageID as string, eventId: e.ID ? String(e.ID) : undefined };
	switch (e.RecordType) {
		case "Delivery":
			return [{ ...base, type: "delivered" }];
		case "Bounce":
			return [{ ...base, type: e.Type === "HardBounce" || e.Inactive === true ? "bounced" : "soft_bounce", detail: String(e.Description ?? "") }];
		case "SpamComplaint":
			return [{ ...base, type: "complained" }];
		case "SubscriptionChange":
			return e.SuppressSending ? [{ ...base, type: "unsubscribed" }] : [];
		default:
			return [];
	}
}

const SPARKPOST_HARD = new Set([10, 25, 30, 90]);

function parseSparkPost(body: unknown): DeliveryEvent[] {
	const out: DeliveryEvent[] = [];
	for (const item of arr(body as Record<string, unknown>[])) {
		const msys = (item.msys ?? {}) as Record<string, Record<string, unknown>>;
		const e = msys.message_event ?? msys.unsubscribe_event ?? msys.track_event;
		if (!e) continue;
		const meta = (e.rcpt_meta ?? e.metadata ?? {}) as Record<string, string>;
		const base = { email: e.rcpt_to as string, outboxId: meta.nl_outbox_id, providerMessageId: e.transmission_id as string, eventId: e.event_id as string };
		if (e.type === "delivery") out.push({ ...base, type: "delivered" });
		else if (e.type === "bounce" || e.type === "out_of_band")
			out.push({ ...base, type: SPARKPOST_HARD.has(Number(e.bounce_class)) ? "bounced" : "soft_bounce", detail: String(e.reason ?? "") });
		else if (e.type === "spam_complaint") out.push({ ...base, type: "complained" });
		else if (e.type === "list_unsubscribe" || e.type === "link_unsubscribe") out.push({ ...base, type: "unsubscribed" });
		else if (e.type === "delay") out.push({ ...base, type: "deferred" });
	}
	return out;
}

function parseSendGrid(body: unknown): DeliveryEvent[] {
	const out: DeliveryEvent[] = [];
	for (const e of arr(body as Record<string, unknown>[])) {
		const base = { email: e.email as string, outboxId: e.nl_outbox_id as string, providerMessageId: String(e.sg_message_id ?? "").split(".")[0], eventId: e.sg_event_id as string };
		if (e.event === "delivered") out.push({ ...base, type: "delivered" });
		else if (e.event === "bounce") out.push({ ...base, type: e.type === "blocked" ? "soft_bounce" : "bounced", detail: String(e.reason ?? "") });
		else if (e.event === "dropped") out.push({ ...base, type: "suppressed", detail: String(e.reason ?? "") });
		else if (e.event === "spamreport") out.push({ ...base, type: "complained" });
		else if (e.event === "unsubscribe" || e.event === "group_unsubscribe") out.push({ ...base, type: "unsubscribed" });
		else if (e.event === "deferred") out.push({ ...base, type: "deferred" });
	}
	return out;
}

function parseSesMessage(msg: Record<string, unknown>): DeliveryEvent[] {
	const kind = (msg.eventType ?? msg.notificationType) as string;
	const mail = (msg.mail ?? {}) as { messageId?: string; tags?: Record<string, string[]> };
	const base = { outboxId: mail.tags?.nl_outbox_id?.[0], providerMessageId: mail.messageId };
	if (kind === "Bounce") {
		const b = msg.bounce as { bounceType?: string; bouncedRecipients?: { emailAddress: string }[] };
		return arr(b?.bouncedRecipients).map((r) => ({ ...base, email: r.emailAddress, type: b.bounceType === "Permanent" ? ("bounced" as const) : ("soft_bounce" as const) }));
	}
	if (kind === "Complaint") {
		const c = msg.complaint as { complainedRecipients?: { emailAddress: string }[] };
		return arr(c?.complainedRecipients).map((r) => ({ ...base, email: r.emailAddress, type: "complained" as const }));
	}
	if (kind === "Delivery") return arr((msg.delivery as { recipients?: string[] })?.recipients).map((email) => ({ ...base, email, type: "delivered" as const }));
	if (kind === "Subscription") return [{ ...base, email: arr((mail as { destination?: string[] }).destination as string[])[0], type: "unsubscribed" }];
	return [];
}

function parseGeneric(body: unknown): DeliveryEvent[] {
	const events = arr((body as { events?: unknown[] })?.events ?? (body as unknown[]));
	const allowed = new Set(["delivered", "bounced", "soft_bounce", "complained", "unsubscribed", "suppressed", "deferred"]);
	return (events as Record<string, string>[])
		.filter((e) => e && allowed.has(e.type))
		.map((e) => ({ type: e.type as DeliveryEventType, email: e.email, outboxId: e.outboxId ?? e.nl_outbox_id, providerMessageId: e.messageId, eventId: e.id }));
}

/** Token that authorises webhook calls on providers without native signatures (`?key=`). */
export async function webhookToken(core: Core): Promise<string> {
	return core.signer.derive("webhook");
}

export async function handleWebhook(core: Core, input: WebhookInput): Promise<WebhookOutcome> {
	const config = await core.settings.get();
	const provider = input.provider.toLowerCase();
	const secret = config.webhookSecrets[provider];
	const keyOk = timingSafeEqual(input.url.searchParams.get("key") ?? "", await webhookToken(core));

	let body: unknown;
	try {
		body = JSON.parse(input.body);
	} catch {
		return { ok: false, status: 400, error: "invalid JSON" };
	}

	// Authenticate: native signature when a secret is configured, otherwise the URL key.
	if ((provider === "bird" || provider === "resend") && secret) {
		if (!(await verifyStandardWebhook(secret, input.headers, input.body))) return { ok: false, status: 401, error: "bad signature" };
	} else if (provider === "mailgun" && secret) {
		const sig = (body as { signature?: { timestamp?: string; token?: string; signature?: string } }).signature;
		const expected = sig?.timestamp && sig.token ? hex(await hmacSha256(secret, sig.timestamp + sig.token)) : "";
		if (!sig?.signature || !timingSafeEqual(sig.signature, expected)) return { ok: false, status: 401, error: "bad signature" };
	} else if (!keyOk) {
		return { ok: false, status: 401, error: "missing or wrong ?key" };
	}

	let events: DeliveryEvent[];
	switch (provider) {
		case "bird":
			events = parseBird(body);
			break;
		case "resend":
			events = parseResend(body);
			break;
		case "mailgun":
			events = parseMailgun(body);
			break;
		case "postmark":
			events = parsePostmark(body);
			break;
		case "sparkpost":
			events = parseSparkPost(body);
			break;
		case "sendgrid":
			events = parseSendGrid(body);
			break;
		case "ses": {
			const sns = body as { Type?: string; SubscribeURL?: string; Message?: string };
			if (sns.Type === "SubscriptionConfirmation" && sns.SubscribeURL) {
				const u = new URL(sns.SubscribeURL);
				if (u.protocol === "https:" && /^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(u.hostname)) await fetch(u.toString());
				return { ok: true, processed: 0, ignored: 0 };
			}
			let msg: Record<string, unknown> = {};
			try {
				msg = sns.Message ? JSON.parse(sns.Message) : (body as Record<string, unknown>);
			} catch {}
			events = parseSesMessage(msg);
			break;
		}
		default:
			events = parseGeneric(body);
	}

	const deliveryId = input.headers.get("webhook-id") ?? input.headers.get("svix-id");
	let processed = 0;
	let ignored = 0;
	for (const [i, e] of events.entries()) {
		const dedupe = e.eventId ?? (deliveryId ? `${deliveryId}:${i}` : null);
		if (dedupe) {
			const seen = await core.db.prepare(`INSERT OR IGNORE INTO nl_webhook_seen (id, received_at) VALUES (?, ?)`).bind(`${provider}:${dedupe}`, now()).run();
			if (((seen as { meta?: { changes?: number } })?.meta?.changes ?? 1) === 0) {
				ignored++;
				continue;
			}
		}
		if (await applyDeliveryEvent(core, provider, e)) processed++;
		else ignored++;
	}
	return { ok: true, processed, ignored };
}

export async function applyDeliveryEvent(core: Core, provider: string, e: DeliveryEvent): Promise<boolean> {
	let ob: { id: string; campaign_id: string | null; subscriber_id: string | null; variant: string | null; email: string } | null = null;
	if (e.outboxId) {
		ob = await core.db.prepare(`SELECT id, campaign_id, subscriber_id, variant, email FROM nl_outbox WHERE id = ?`).bind(e.outboxId).first();
	}
	if (!ob && e.providerMessageId) {
		ob = await core.db
			.prepare(`SELECT id, campaign_id, subscriber_id, variant, email FROM nl_outbox WHERE provider_message_id = ? ${e.email ? "AND email = ?" : ""} LIMIT 1`)
			.bind(e.providerMessageId, ...(e.email ? [normalizeEmail(e.email) ?? e.email] : []))
			.first();
	}
	const email = normalizeEmail(e.email ?? ob?.email);
	let subscriberId = ob?.subscriber_id ?? null;
	if (!subscriberId && email) subscriberId = (await getSubscriberByEmail(core, email))?.id ?? null;
	if (!ob && !subscriberId && !email) return false;

	await core.db
		.prepare(`INSERT INTO nl_events (type, outbox_id, campaign_id, subscriber_id, variant, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
		.bind(e.type, ob?.id ?? null, ob?.campaign_id ?? null, subscriberId, ob?.variant ?? null, JSON.stringify({ provider, ...(e.detail && { detail: e.detail.slice(0, 300) }) }), now())
		.run();

	if (e.type === "bounced" || e.type === "complained") {
		if (email) {
			await core.db
				.prepare(`INSERT OR REPLACE INTO nl_suppressions (email, reason, created_at) VALUES (?, ?, ?)`)
				.bind(email, e.type === "complained" ? "complaint" : "hard_bounce", now())
				.run();
		}
		if (subscriberId) await unsubscribe(core, subscriberId, e.type === "complained" ? "complaint" : "bounce", ob?.campaign_id);
	} else if (e.type === "unsubscribed" && subscriberId) {
		await unsubscribe(core, subscriberId, "provider", ob?.campaign_id);
	} else if (e.type === "suppressed" && subscriberId) {
		// The provider refused to deliver to this address. Stop mailing it until they resubscribe.
		await unsubscribe(core, subscriberId, "provider", ob?.campaign_id);
	}
	return true;
}
