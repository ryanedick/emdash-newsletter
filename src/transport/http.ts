/**
 * HTTP API transports. Each is a thin mapping from `OutboundEmail` to one
 * provider's send API, with native batching where the provider has it.
 * All take an optional `fetch` for tests.
 */
import { hex, hmacSha256, sha256Hex } from "../crypto.ts";
import { b64, utf8 } from "../util.ts";
import {
	type BatchItemResult,
	EmailSendError,
	type EmailTransport,
	type FetchLike,
	formatAddress,
	type OutboundEmail,
	retryableStatus,
	sequentialBatch,
	toAddress,
	toList,
} from "./types.ts";

const UNSUB_HEADERS = new Set(["list-unsubscribe", "list-unsubscribe-post"]);

async function failure(provider: string, res: Response, context: string): Promise<EmailSendError> {
	let detail = "";
	try {
		detail = (await res.text()).slice(0, 500);
	} catch {}
	return new EmailSendError(provider, `HTTP_${res.status}`, `${provider} ${context} failed (${res.status}): ${detail}`, {
		retryable: retryableStatus(res.status),
	});
}

function networkError(provider: string, err: unknown): EmailSendError {
	return new EmailSendError(provider, "E_NETWORK", `${provider}: ${(err as Error)?.message ?? err}`, { retryable: true, cause: err });
}

async function call(provider: string, f: FetchLike, url: string, init: RequestInit, context: string): Promise<Response> {
	let res: Response;
	try {
		res = await f(url, init);
	} catch (err) {
		throw networkError(provider, err);
	}
	if (!res.ok) throw await failure(provider, res, context);
	return res;
}

function batchFail(messages: OutboundEmail[], err: unknown, provider: string): BatchItemResult[] {
	const e = err instanceof EmailSendError ? err : networkError(provider, err);
	return messages.map(() => ({ ok: false as const, error: e }));
}

/** Tag values providers accept: ASCII letters, digits, `_` and `-`. */
const tagSafe = (s: string, max = 64) => s.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, max);

// ───────────────────────────────── Bird ─────────────────────────────────

export interface BirdConfig {
	apiKey: string;
	/** "us1" | "eu1". Derived from the key prefix (bk_eu1_…) when omitted. */
	region?: string;
	/**
	 * Bird send category. "marketing" (default) applies every suppression and
	 * Bird-managed unsubscribe (our List-Unsubscribe headers are left off, Bird's
	 * unsubscribe events flow back through the webhook). "transactional" keeps
	 * our own List-Unsubscribe headers.
	 */
	category?: "marketing" | "transactional";
	ipPoolId?: string;
	/** Override the API origin (e.g. the local mock). */
	baseUrl?: string;
	fetch?: FetchLike;
}

export function birdRegion(apiKey: string, region?: string): string {
	if (region) return region;
	const m = /^b[km]_([a-z]+\d)_/.exec(apiKey);
	return m?.[1] ?? "us1";
}

export function birdTransport(config: BirdConfig): EmailTransport {
	const provider = "bird";
	if (!config.apiKey) throw new Error("birdTransport: apiKey is required");
	const f = config.fetch ?? fetch;
	const base = config.baseUrl ?? `https://${birdRegion(config.apiKey, config.region)}.platform.bird.com`;
	const category = config.category ?? "marketing";

	function item(m: OutboundEmail) {
		const headers = Object.fromEntries(
			Object.entries(m.headers ?? {}).filter(([k]) => category === "transactional" || !UNSUB_HEADERS.has(k.toLowerCase())),
		);
		const metadata = m.metadata && Object.keys(m.metadata).length ? m.metadata : undefined;
		return {
			from: toAddress(m.from),
			to: toList(m.to),
			subject: m.subject,
			html: m.html,
			text: m.text,
			...(m.replyTo && { reply_to: [toAddress(m.replyTo)] }),
			...(Object.keys(headers).length > 0 && { headers }),
			...(metadata && { metadata }),
			...(m.category && { tags: [{ name: "category", value: tagSafe(m.category) }] }),
			category,
			track_opens: m.providerTracking ?? false,
			track_clicks: m.providerTracking ?? false,
			...(config.ipPoolId && { ip_pool_id: config.ipPoolId }),
		};
	}

	const headers = (idem?: string): Record<string, string> => ({
		Authorization: `Bearer ${config.apiKey}`,
		"Content-Type": "application/json",
		...(idem && { "Idempotency-Key": idem.slice(0, 255) }),
	});

	async function sendBatch(messages: OutboundEmail[]): Promise<BatchItemResult[]> {
		if (messages.length === 0) return [];
		if (messages.length > 100) throw new Error("birdTransport: batches are limited to 100 messages");
		try {
			const idem = messages.every((m) => m.idempotencyKey) ? `batch/${await sha256Hex(messages.map((m) => m.idempotencyKey).join(","))}` : undefined;
			const res = await call(provider, f, `${base}/v1/email/batches`, {
				method: "POST",
				headers: headers(idem),
				body: JSON.stringify({ messages: messages.map(item) }),
			}, "batch send");
			const data = ((await res.json()) as { data?: { id?: string }[] }).data ?? [];
			return messages.map((_, i) => ({ ok: true as const, messageId: data[i]?.id }));
		} catch (err) {
			// Bird validates a batch as a unit: one bad item rejects all. When the
			// error isn't retryable, fall back to single sends so good messages still go.
			if (err instanceof EmailSendError && !err.retryable && messages.length > 1) {
				return sequentialBatch({ name: provider, send }, messages, 4);
			}
			return batchFail(messages, err, provider);
		}
	}

	async function send(m: OutboundEmail) {
		const res = await call(provider, f, `${base}/v1/email/messages`, {
			method: "POST",
			headers: headers(m.idempotencyKey),
			body: JSON.stringify(item(m)),
		}, "send");
		const body = (await res.json()) as { id?: string; data?: { id?: string } };
		return { messageId: body.id ?? body.data?.id };
	}

	return {
		name: provider,
		maxBatch: 100,
		send,
		sendBatch,
		async verify() {
			try {
				// Needs only the emails scope, like sending.
				const res = await f(`${base}/v1/email/messages?limit=1`, { headers: headers() });
				if (res.ok) return { ok: true, detail: "Bird API key accepted" };
				return { ok: false, detail: `Bird returned ${res.status}: ${(await res.text()).slice(0, 200)}` };
			} catch (err) {
				return { ok: false, detail: (err as Error).message };
			}
		},
	};
}

// ─────────────────────────────── SparkPost ───────────────────────────────

export interface SparkPostConfig {
	apiKey: string;
	region?: "us" | "eu";
	fetch?: FetchLike;
}

export function sparkpostTransport(config: SparkPostConfig): EmailTransport {
	const provider = "sparkpost";
	const f = config.fetch ?? fetch;
	const base = config.region === "eu" ? "https://api.eu.sparkpost.com" : "https://api.sparkpost.com";
	async function send(m: OutboundEmail) {
		const res = await call(provider, f, `${base}/api/v1/transmissions`, {
			method: "POST",
			headers: { Authorization: config.apiKey, "Content-Type": "application/json" },
			body: JSON.stringify({
				options: { open_tracking: m.providerTracking ?? false, click_tracking: m.providerTracking ?? false, transactional: m.category !== "newsletter" },
				...(m.category && { campaign_id: m.category.slice(0, 64) }),
				...(m.metadata && { metadata: m.metadata }),
				recipients: toList(m.to).map((a) => ({ address: a })),
				content: {
					from: toAddress(m.from),
					subject: m.subject,
					html: m.html,
					text: m.text,
					...(m.replyTo && { reply_to: formatAddress(m.replyTo) }),
					...(m.headers && { headers: m.headers }),
				},
			}),
		}, "transmission");
		const body = (await res.json()) as { results?: { id?: string } };
		return { messageId: body.results?.id };
	}
	return {
		name: provider,
		maxBatch: 1,
		send,
		sendBatch: (msgs) => sequentialBatch({ name: provider, send }, msgs, 6),
		async verify() {
			const res = await f(`${base}/api/v1/account`, { headers: { Authorization: config.apiKey } }).catch((e) => e as Error);
			if (res instanceof Error) return { ok: false, detail: res.message };
			return res.ok ? { ok: true, detail: "SparkPost API key accepted" } : { ok: false, detail: `SparkPost returned ${res.status}` };
		},
	};
}

// ──────────────────────────────── Mailgun ────────────────────────────────

export interface MailgunConfig {
	apiKey: string;
	domain: string;
	region?: "us" | "eu";
	fetch?: FetchLike;
}

export function mailgunTransport(config: MailgunConfig): EmailTransport {
	const provider = "mailgun";
	const f = config.fetch ?? fetch;
	const base = config.region === "eu" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net";
	const auth = `Basic ${b64.encode(utf8.encode(`api:${config.apiKey}`))}`;
	async function send(m: OutboundEmail) {
		const form = new FormData();
		form.set("from", formatAddress(m.from));
		for (const t of toList(m.to)) form.append("to", formatAddress(t));
		form.set("subject", m.subject);
		form.set("text", m.text);
		form.set("html", m.html);
		if (m.replyTo) form.set("h:Reply-To", formatAddress(m.replyTo));
		for (const [k, v] of Object.entries(m.headers ?? {})) form.set(`h:${k}`, v);
		for (const [k, v] of Object.entries(m.metadata ?? {})) form.set(`v:${k}`, v);
		if (m.category) form.set("o:tag", m.category);
		form.set("o:tracking", m.providerTracking ? "yes" : "no");
		const res = await call(provider, f, `${base}/v3/${encodeURIComponent(config.domain)}/messages`, {
			method: "POST",
			headers: { Authorization: auth },
			body: form,
		}, "send");
		const body = (await res.json()) as { id?: string };
		return { messageId: body.id?.replace(/^<|>$/g, "") };
	}
	return {
		name: provider,
		maxBatch: 1,
		send,
		sendBatch: (msgs) => sequentialBatch({ name: provider, send }, msgs, 6),
		async verify() {
			const res = await f(`${base}/v3/domains/${encodeURIComponent(config.domain)}`, { headers: { Authorization: auth } }).catch((e) => e as Error);
			if (res instanceof Error) return { ok: false, detail: res.message };
			return res.ok ? { ok: true, detail: `Mailgun domain ${config.domain} found` } : { ok: false, detail: `Mailgun returned ${res.status}` };
		},
	};
}

// ──────────────────────────────── Postmark ───────────────────────────────

export interface PostmarkConfig {
	serverToken: string;
	/** Message stream. Postmark requires "broadcast" (or a custom broadcast stream) for newsletters. */
	messageStream?: string;
	fetch?: FetchLike;
}

export function postmarkTransport(config: PostmarkConfig): EmailTransport {
	const provider = "postmark";
	const f = config.fetch ?? fetch;
	const headers = { "X-Postmark-Server-Token": config.serverToken, "Content-Type": "application/json", Accept: "application/json" };
	const item = (m: OutboundEmail) => ({
		From: formatAddress(m.from),
		To: toList(m.to).map(formatAddress).join(","),
		Subject: m.subject,
		HtmlBody: m.html,
		TextBody: m.text,
		...(m.replyTo && { ReplyTo: formatAddress(m.replyTo) }),
		...(m.headers && { Headers: Object.entries(m.headers).map(([Name, Value]) => ({ Name, Value })) }),
		...(m.metadata && { Metadata: m.metadata }),
		...(m.category && { Tag: m.category.slice(0, 1000) }),
		MessageStream: config.messageStream ?? (m.category === "newsletter" || m.category === "automation" ? "broadcast" : "outbound"),
		TrackOpens: m.providerTracking ?? false,
		TrackLinks: m.providerTracking ? "HtmlAndText" : "None",
	});
	async function sendBatch(messages: OutboundEmail[]): Promise<BatchItemResult[]> {
		if (messages.length === 0) return [];
		try {
			const res = await call(provider, f, "https://api.postmarkapp.com/email/batch", {
				method: "POST",
				headers,
				body: JSON.stringify(messages.map(item)),
			}, "batch send");
			const rows = (await res.json()) as { ErrorCode: number; MessageID?: string; Message?: string }[];
			return messages.map((_, i) => {
				const r = rows[i];
				if (r && r.ErrorCode === 0) return { ok: true as const, messageId: r.MessageID };
				const code = r?.ErrorCode ?? -1;
				return {
					ok: false as const,
					error: new EmailSendError(provider, `PM_${code}`, `Postmark: ${r?.Message ?? "unknown error"}`, {
						retryable: code === 429 || code === -1,
						permanentRecipient: code === 406 || code === 300,
					}),
				};
			});
		} catch (err) {
			return batchFail(messages, err, provider);
		}
	}
	return {
		name: provider,
		maxBatch: 500,
		async send(m) {
			const [r] = await sendBatch([m]);
			if (!r.ok) throw r.error;
			return { messageId: r.messageId };
		},
		sendBatch,
		async verify() {
			const res = await f("https://api.postmarkapp.com/server", { headers }).catch((e) => e as Error);
			if (res instanceof Error) return { ok: false, detail: res.message };
			return res.ok ? { ok: true, detail: "Postmark server token accepted" } : { ok: false, detail: `Postmark returned ${res.status}` };
		},
	};
}

// ───────────────────────────────── Resend ────────────────────────────────

export interface ResendConfig {
	apiKey: string;
	fetch?: FetchLike;
}

export function resendTransport(config: ResendConfig): EmailTransport {
	const provider = "resend";
	const f = config.fetch ?? fetch;
	const item = (m: OutboundEmail) => ({
		from: formatAddress(m.from),
		to: toList(m.to).map(formatAddress),
		subject: m.subject,
		html: m.html,
		text: m.text,
		...(m.replyTo && { reply_to: formatAddress(m.replyTo) }),
		...(m.headers && { headers: m.headers }),
		tags: [
			...(m.category ? [{ name: "category", value: tagSafe(m.category, 256) }] : []),
			...Object.entries(m.metadata ?? {}).map(([name, value]) => ({ name: tagSafe(name, 256), value: tagSafe(value, 256) })),
		],
	});
	const headers = (idem?: string) => ({
		Authorization: `Bearer ${config.apiKey}`,
		"Content-Type": "application/json",
		...(idem && { "Idempotency-Key": idem.slice(0, 256) }),
	});
	async function sendBatch(messages: OutboundEmail[]): Promise<BatchItemResult[]> {
		if (messages.length === 0) return [];
		try {
			const res = await call(provider, f, "https://api.resend.com/emails/batch", {
				method: "POST",
				headers: headers(),
				body: JSON.stringify(messages.map(item)),
			}, "batch send");
			const data = ((await res.json()) as { data?: { id: string }[] }).data ?? [];
			return messages.map((_, i) => ({ ok: true as const, messageId: data[i]?.id }));
		} catch (err) {
			return batchFail(messages, err, provider);
		}
	}
	return {
		name: provider,
		maxBatch: 100,
		async send(m) {
			const res = await call(provider, f, "https://api.resend.com/emails", {
				method: "POST",
				headers: headers(m.idempotencyKey),
				body: JSON.stringify(item(m)),
			}, "send");
			return { messageId: ((await res.json()) as { id?: string }).id };
		},
		sendBatch,
		async verify() {
			const res = await f("https://api.resend.com/domains", { headers: headers() }).catch((e) => e as Error);
			if (res instanceof Error) return { ok: false, detail: res.message };
			return res.ok ? { ok: true, detail: "Resend API key accepted" } : { ok: false, detail: `Resend returned ${res.status}` };
		},
	};
}

// ──────────────────────────────── SendGrid ───────────────────────────────

export interface SendGridConfig {
	apiKey: string;
	fetch?: FetchLike;
}

export function sendgridTransport(config: SendGridConfig): EmailTransport {
	const provider = "sendgrid";
	const f = config.fetch ?? fetch;
	const headers = { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" };
	async function send(m: OutboundEmail) {
		const res = await call(provider, f, "https://api.sendgrid.com/v3/mail/send", {
			method: "POST",
			headers,
			body: JSON.stringify({
				personalizations: [{ to: toList(m.to), ...(m.metadata && { custom_args: m.metadata }) }],
				from: toAddress(m.from),
				...(m.replyTo && { reply_to: toAddress(m.replyTo) }),
				subject: m.subject,
				content: [
					{ type: "text/plain", value: m.text },
					{ type: "text/html", value: m.html },
				],
				...(m.headers && { headers: m.headers }),
				...(m.category && { categories: [m.category.slice(0, 255)] }),
				tracking_settings: {
					click_tracking: { enable: m.providerTracking ?? false },
					open_tracking: { enable: m.providerTracking ?? false },
				},
			}),
		}, "send");
		return { messageId: res.headers.get("x-message-id") ?? undefined };
	}
	return {
		name: provider,
		maxBatch: 1,
		send,
		sendBatch: (msgs) => sequentialBatch({ name: provider, send }, msgs, 6),
		async verify() {
			const res = await f("https://api.sendgrid.com/v3/scopes", { headers }).catch((e) => e as Error);
			if (res instanceof Error) return { ok: false, detail: res.message };
			return res.ok ? { ok: true, detail: "SendGrid API key accepted" } : { ok: false, detail: `SendGrid returned ${res.status}` };
		},
	};
}

// ─────────────────────────────── Amazon SES ──────────────────────────────

export interface SesConfig {
	accessKeyId: string;
	secretAccessKey: string;
	region: string;
	configurationSet?: string;
	fetch?: FetchLike;
}

async function sigV4(
	config: SesConfig,
	method: string,
	url: URL,
	body: string,
	service = "ses",
): Promise<Record<string, string>> {
	const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
	const date = amzDate.slice(0, 8);
	const payloadHash = await sha256Hex(body);
	const canonicalHeaders = `content-type:application/json\nhost:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
	const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
	const canonical = [method, url.pathname, url.search.slice(1), canonicalHeaders, signedHeaders, payloadHash].join("\n");
	const scope = `${date}/${config.region}/${service}/aws4_request`;
	const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonical)].join("\n");
	let key: Uint8Array = utf8.encode(`AWS4${config.secretAccessKey}`);
	for (const part of [date, config.region, service, "aws4_request"]) key = await hmacSha256(key, part);
	const signature = hex(await hmacSha256(key, toSign));
	return {
		"Content-Type": "application/json",
		"X-Amz-Date": amzDate,
		"X-Amz-Content-Sha256": payloadHash,
		Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
	};
}

export function sesTransport(config: SesConfig): EmailTransport {
	const provider = "ses";
	const f = config.fetch ?? fetch;
	const endpoint = new URL(`https://email.${config.region}.amazonaws.com/v2/email/outbound-emails`);
	async function send(m: OutboundEmail) {
		const body = JSON.stringify({
			FromEmailAddress: formatAddress(m.from),
			Destination: { ToAddresses: toList(m.to).map(formatAddress) },
			...(m.replyTo && { ReplyToAddresses: [formatAddress(m.replyTo)] }),
			Content: {
				Simple: {
					Subject: { Data: m.subject, Charset: "UTF-8" },
					Body: { Text: { Data: m.text, Charset: "UTF-8" }, Html: { Data: m.html, Charset: "UTF-8" } },
					...(m.headers && { Headers: Object.entries(m.headers).map(([Name, Value]) => ({ Name, Value })) }),
				},
			},
			EmailTags: [
				...(m.category ? [{ Name: "category", Value: tagSafe(m.category, 256) }] : []),
				...Object.entries(m.metadata ?? {}).map(([k, v]) => ({ Name: tagSafe(k, 256), Value: tagSafe(v, 256) })),
			],
			...(config.configurationSet && { ConfigurationSetName: config.configurationSet }),
		});
		const res = await call(provider, f, endpoint.toString(), { method: "POST", headers: await sigV4(config, "POST", endpoint, body), body }, "send");
		return { messageId: ((await res.json()) as { MessageId?: string }).MessageId };
	}
	return {
		name: provider,
		maxBatch: 1,
		send,
		sendBatch: (msgs) => sequentialBatch({ name: provider, send }, msgs, 8),
		async verify() {
			const url = new URL(`https://email.${config.region}.amazonaws.com/v2/email/account`);
			try {
				const amz = await sigV4(config, "GET", url, "");
				const res = await f(url.toString(), { headers: amz });
				return res.ok ? { ok: true, detail: "SES credentials accepted" } : { ok: false, detail: `SES returned ${res.status}` };
			} catch (err) {
				return { ok: false, detail: (err as Error).message };
			}
		},
	};
}

// ─────────────────────────── Cloudflare Email Service ───────────────────────────

/** The part of Cloudflare's `send_email` binding used here (pass `env.EMAIL`). */
export interface CloudflareSendEmailBinding {
	send(message: {
		from: string | { email: string; name: string };
		to: string | string[];
		subject: string;
		replyTo?: string;
		headers?: Record<string, string>;
		html?: string;
		text?: string;
	}): Promise<{ messageId: string }>;
}

/** Transactional only: Cloudflare Email Service isn't meant for newsletters. */
export function cloudflareTransport(binding: CloudflareSendEmailBinding): EmailTransport {
	const provider = "cloudflare-email";
	async function send(m: OutboundEmail) {
		const from = toAddress(m.from);
		try {
			const res = await binding.send({
				from: from.name ? { email: from.email, name: from.name } : from.email,
				to: toList(m.to).map((a) => a.email),
				subject: m.subject,
				html: m.html,
				text: m.text,
				...(m.replyTo && { replyTo: toAddress(m.replyTo).email }),
				...(m.headers && { headers: m.headers }),
			});
			return { messageId: res?.messageId };
		} catch (err) {
			const code = String((err as { code?: unknown })?.code ?? "E_UNKNOWN");
			throw new EmailSendError(provider, code, `Cloudflare Email: ${(err as Error)?.message ?? code}`, {
				retryable: /RATE|LIMIT|INTERNAL/.test(code),
				cause: err,
			});
		}
	}
	return { name: provider, maxBatch: 1, send, sendBatch: (msgs) => sequentialBatch({ name: provider, send }, msgs, 4) };
}
