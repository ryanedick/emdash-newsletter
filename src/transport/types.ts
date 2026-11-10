/**
 * Provider-neutral email transport. Every provider (Bird, SMTP, SparkPost,
 * Mailgun, …) implements this. The newsletter engine never talks to a
 * provider directly.
 *
 * `OutboundEmail` is a superset of the `emdash-memberships` transport shape, so
 * a transport built here can also deliver the memberships sign-in emails.
 */

export interface EmailAddress {
	email: string;
	name?: string;
}

export type Address = string | EmailAddress;

export interface OutboundEmail {
	from: Address;
	to: Address | Address[];
	subject: string;
	html: string;
	text: string;
	replyTo?: Address;
	/** Extra headers such as List-Unsubscribe. Providers may drop reserved ones. */
	headers?: Record<string, string>;
	/** Low-cardinality label: "newsletter", "confirmation", "automation"… */
	category?: string;
	/**
	 * Correlation data echoed back in provider webhooks where supported.
	 * The engine sets `nl_outbox_id` so events can be matched to a recipient.
	 */
	metadata?: Record<string, string>;
	/** Stable key so provider-side retries never double-send. */
	idempotencyKey?: string;
	/** Whether the provider should add its own open/click tracking (we track ourselves by default). */
	providerTracking?: boolean;
}

export interface SendResult {
	messageId?: string;
}

export type BatchItemResult = { ok: true; messageId?: string } | { ok: false; error: EmailSendError };

export interface EmailTransport {
	/** Provider name for logs and the outbox record. */
	readonly name: string;
	/** Largest batch `sendBatch` accepts. 1 means no native batching. */
	readonly maxBatch: number;
	send(message: OutboundEmail): Promise<SendResult>;
	/**
	 * Sends many independent messages. Results are in input order. Implementations
	 * without a native batch API send sequentially (or over one SMTP connection).
	 */
	sendBatch(messages: OutboundEmail[]): Promise<BatchItemResult[]>;
	/** Checks credentials/connectivity without sending, where the provider allows. */
	verify?(): Promise<{ ok: boolean; detail: string }>;
}

/**
 * Normalised send failure. `retryable` means a later attempt may succeed
 * (rate limit, outage, timeout); otherwise the message or config needs fixing.
 * `permanentRecipient` marks failures caused by the address itself.
 */
export class EmailSendError extends Error {
	readonly code: string;
	readonly retryable: boolean;
	readonly provider: string;
	readonly permanentRecipient: boolean;

	constructor(
		provider: string,
		code: string,
		message: string,
		options: { retryable: boolean; permanentRecipient?: boolean; cause?: unknown },
	) {
		super(message, { cause: options.cause });
		this.name = "EmailSendError";
		this.provider = provider;
		this.code = code;
		this.retryable = options.retryable;
		this.permanentRecipient = options.permanentRecipient ?? false;
	}
}

export function toAddress(a: Address): EmailAddress {
	if (typeof a !== "string") return a;
	const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(a);
	return m ? { email: m[2].trim(), name: m[1].trim() || undefined } : { email: a.trim() };
}

export function toList(a: Address | Address[] | undefined): EmailAddress[] {
	if (!a) return [];
	return (Array.isArray(a) ? a : [a]).map(toAddress);
}

export function formatAddress(a: Address): string {
	const { email, name } = toAddress(a);
	if (!name) return email;
	return `"${name.replace(/["\\\r\n]/g, "")}" <${email}>`;
}

/** Status codes where retrying later may succeed. */
export function retryableStatus(status: number): boolean {
	return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/** Default `sendBatch` for transports that only send one at a time. */
export async function sequentialBatch(
	transport: Pick<EmailTransport, "send" | "name">,
	messages: OutboundEmail[],
	concurrency = 4,
): Promise<BatchItemResult[]> {
	const results: BatchItemResult[] = new Array(messages.length);
	let next = 0;
	async function worker() {
		while (next < messages.length) {
			const i = next++;
			try {
				const r = await transport.send(messages[i]);
				results[i] = { ok: true, messageId: r.messageId };
			} catch (err) {
				results[i] = { ok: false, error: asSendError(transport.name, err) };
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, messages.length) }, worker));
	return results;
}

export function asSendError(provider: string, err: unknown): EmailSendError {
	if (err instanceof EmailSendError) return err;
	const e = err as Error;
	return new EmailSendError(provider, "E_UNKNOWN", e?.message ?? String(err), { retryable: true, cause: err });
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
