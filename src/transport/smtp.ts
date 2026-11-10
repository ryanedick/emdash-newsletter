/**
 * SMTP transport over raw TCP sockets (Cloudflare Workers `connect()` from
 * `cloudflare:sockets`, or any compatible socket factory). Works with any SMTP
 * relay: Bird, SparkPost, Mailgun, Amazon SES, Postmark, SendGrid, Brevo,
 * Google Workspace, your own Postfix…
 *
 * - Implicit TLS (port 465) or STARTTLS (587/2525). Plain is allowed only when
 *   explicitly configured, and never with AUTH.
 * - AUTH PLAIN or LOGIN.
 * - One connection carries a whole batch (RSET between messages after errors).
 *
 * Note: Workers block outbound port 25. Use 465, 587 or 2525.
 */
import { b64, utf8 } from "../util.ts";
import { buildMime } from "./mime.ts";
import {
	type BatchItemResult,
	EmailSendError,
	type EmailTransport,
	type OutboundEmail,
	toAddress,
	toList,
} from "./types.ts";

export interface SmtpSocket {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
	startTls(): SmtpSocket;
	close(): Promise<void> | void;
	opened?: Promise<unknown>;
}

export type SocketConnect = (
	address: { hostname: string; port: number },
	options: { secureTransport: "on" | "off" | "starttls"; allowHalfOpen: boolean },
) => SmtpSocket;

export interface SmtpConfig {
	host: string;
	port: number;
	/** "tls" = implicit TLS (465), "starttls" = upgrade (587/2525), "none" = plaintext (testing only). */
	security: "tls" | "starttls" | "none";
	username?: string;
	password?: string;
	/** Name sent in EHLO. Defaults to the From domain. */
	clientName?: string;
	/** Per-command timeout in ms (default 20s). */
	timeoutMs?: number;
	/** Override the socket factory (tests, Node). Defaults to `cloudflare:sockets`. */
	connect?: SocketConnect;
	/** Name for logs (e.g. "bird-smtp"). */
	name?: string;
}

interface Reply {
	code: number;
	lines: string[];
	text: string;
}

const PERMANENT_RECIPIENT = new Set([550, 551, 553]);

class Session {
	#socket: SmtpSocket;
	#reader!: ReadableStreamDefaultReader<Uint8Array>;
	#writer!: WritableStreamDefaultWriter<Uint8Array>;
	#buffer = "";
	#decoder = new TextDecoder();
	#timeout: number;
	#provider: string;
	capabilities = new Set<string>();
	authMechs = new Set<string>();

	constructor(socket: SmtpSocket, timeout: number, provider: string) {
		this.#socket = socket;
		this.#timeout = timeout;
		this.#provider = provider;
		this.#attach();
	}

	#attach() {
		this.#reader = this.#socket.readable.getReader();
		this.#writer = this.#socket.writable.getWriter();
		this.#buffer = "";
	}

	async upgrade() {
		this.#reader.releaseLock();
		this.#writer.releaseLock();
		this.#socket = this.#socket.startTls();
		this.#attach();
	}

	async #readLine(): Promise<string> {
		while (true) {
			const i = this.#buffer.indexOf("\r\n");
			if (i >= 0) {
				const line = this.#buffer.slice(0, i);
				this.#buffer = this.#buffer.slice(i + 2);
				return line;
			}
			const { value, done } = await this.#withTimeout(this.#reader.read(), "read");
			if (done) throw this.#error("E_CONNECTION_CLOSED", "SMTP server closed the connection", true);
			this.#buffer += this.#decoder.decode(value, { stream: true });
		}
	}

	async read(): Promise<Reply> {
		const lines: string[] = [];
		while (true) {
			const line = await this.#readLine();
			const m = /^(\d{3})([ -])(.*)$/.exec(line);
			if (!m) throw this.#error("E_PROTOCOL", `Unexpected SMTP line: ${line.slice(0, 120)}`, true);
			lines.push(m[3]);
			if (m[2] === " ") return { code: Number(m[1]), lines, text: lines.join(" ") };
		}
	}

	async write(data: string) {
		await this.#withTimeout(this.#writer.write(utf8.encode(data)), "write");
	}

	async command(line: string, expect: number[], sensitive = false): Promise<Reply> {
		await this.write(`${line}\r\n`);
		const reply = await this.read();
		if (!expect.includes(reply.code)) {
			const shown = sensitive ? line.split(" ").slice(0, 2).join(" ") : line.slice(0, 60);
			throw this.replyError(reply, shown);
		}
		return reply;
	}

	replyError(reply: Reply, context: string): EmailSendError {
		const transient = reply.code >= 400 && reply.code < 500;
		return new EmailSendError(this.#provider, `SMTP_${reply.code}`, `SMTP ${reply.code} after ${context}: ${reply.text.slice(0, 300)}`, {
			retryable: transient,
			permanentRecipient: PERMANENT_RECIPIENT.has(reply.code) && /RCPT/i.test(context),
		});
	}

	#error(code: string, message: string, retryable: boolean) {
		return new EmailSendError(this.#provider, code, message, { retryable });
	}

	async #withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				p,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(this.#error("E_TIMEOUT", `SMTP ${what} timed out`, true)), this.#timeout);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	parseEhlo(reply: Reply) {
		this.capabilities.clear();
		this.authMechs.clear();
		for (const l of reply.lines.slice(1)) {
			const [cap, ...rest] = l.trim().toUpperCase().split(/\s+/);
			this.capabilities.add(cap);
			if (cap === "AUTH") for (const m of rest) this.authMechs.add(m);
		}
	}

	async close() {
		try {
			await this.write("QUIT\r\n");
		} catch {}
		try {
			this.#reader.releaseLock();
			this.#writer.releaseLock();
		} catch {}
		try {
			await this.#socket.close();
		} catch {}
	}
}

async function defaultConnect(): Promise<SocketConnect> {
	// Literal specifier so Worker bundlers keep it as the built-in module.
	const m = (await import("cloudflare:sockets")) as unknown as { connect: SocketConnect };
	return m.connect;
}

/** Pulls a provider message id out of the final 250 reply ("queued as X", "id=X", or a lone token). */
function queuedId(text: string): string | undefined {
	const m = /queued as ([^\s]+)/i.exec(text) ?? /\bid[=:]\s*<?([^\s>]+)/i.exec(text) ?? /\b(em_[a-z0-9]+)\b/i.exec(text);
	return m?.[1];
}

export function smtpTransport(config: SmtpConfig): EmailTransport {
	const provider = config.name ?? "smtp";
	const timeout = config.timeoutMs ?? 20_000;
	if (!config.host || !config.port) throw new Error("smtpTransport: host and port are required");
	if (config.security === "none" && config.username) {
		throw new Error("smtpTransport: refusing to send credentials over plaintext. Use tls or starttls.");
	}

	async function open(from: string): Promise<Session> {
		const connect = config.connect ?? (await defaultConnect());
		const socket = connect(
			{ hostname: config.host, port: config.port },
			{ secureTransport: config.security === "tls" ? "on" : config.security === "starttls" ? "starttls" : "off", allowHalfOpen: false },
		);
		const s = new Session(socket, timeout, provider);
		try {
			const greet = await s.read();
			if (greet.code !== 220) throw s.replyError(greet, "connect");
			const helo = config.clientName ?? (from.split("@")[1] || "localhost");
			s.parseEhlo(await s.command(`EHLO ${helo}`, [250]));
			if (config.security === "starttls") {
				if (!s.capabilities.has("STARTTLS")) {
					throw new EmailSendError(provider, "E_NO_STARTTLS", "SMTP server does not offer STARTTLS", { retryable: false });
				}
				await s.command("STARTTLS", [220]);
				await s.upgrade();
				s.parseEhlo(await s.command(`EHLO ${helo}`, [250]));
			}
			if (config.username) {
				const user = config.username;
				const pass = config.password ?? "";
				if (s.authMechs.has("PLAIN") || s.authMechs.size === 0) {
					const token = b64.encode(utf8.encode(`\u0000${user}\u0000${pass}`));
					await s.command(`AUTH PLAIN ${token}`, [235], true);
				} else if (s.authMechs.has("LOGIN")) {
					await s.command("AUTH LOGIN", [334]);
					await s.command(b64.encode(utf8.encode(user)), [334], true);
					await s.command(b64.encode(utf8.encode(pass)), [235], true);
				} else {
					throw new EmailSendError(provider, "E_AUTH_UNSUPPORTED", `No supported AUTH mechanism (${[...s.authMechs].join(", ")})`, {
						retryable: false,
					});
				}
			}
			return s;
		} catch (err) {
			await s.close();
			if (err instanceof EmailSendError && err.code === "SMTP_535") {
				throw new EmailSendError(provider, err.code, err.message, { retryable: false, cause: err });
			}
			throw err;
		}
	}

	async function transmit(s: Session, msg: OutboundEmail): Promise<string | undefined> {
		const from = toAddress(msg.from).email;
		const rcpts = toList(msg.to).map((a) => a.email);
		const domain = from.split("@")[1] ?? "localhost";
		const messageId = `<${msg.metadata?.nl_outbox_id ?? crypto.randomUUID()}@${domain}>`;
		const mime = buildMime(msg, { messageId });
		await s.command(`MAIL FROM:<${from}>${s.capabilities.has("8BITMIME") ? " BODY=8BITMIME" : ""}`, [250]);
		for (const r of rcpts) await s.command(`RCPT TO:<${r}>`, [250, 251]);
		await s.command("DATA", [354]);
		// Dot-stuff lines starting with "." and terminate with <CRLF>.<CRLF>
		const body = mime.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
		await s.write(`${body.endsWith("\r\n") ? body : `${body}\r\n`}.\r\n`);
		const done = await s.read();
		if (done.code !== 250) throw s.replyError(done, "DATA");
		return queuedId(done.text) ?? messageId;
	}

	async function sendBatch(messages: OutboundEmail[]): Promise<BatchItemResult[]> {
		const results: BatchItemResult[] = [];
		if (messages.length === 0) return results;
		let session: Session | null = null;
		try {
			for (const msg of messages) {
				try {
					session ??= await open(toAddress(msg.from).email);
					const id = await transmit(session, msg);
					results.push({ ok: true, messageId: id });
				} catch (err) {
					const e =
						err instanceof EmailSendError
							? err
							: new EmailSendError(provider, "E_UNKNOWN", (err as Error)?.message ?? String(err), { retryable: true, cause: err });
					results.push({ ok: false, error: e });
					if (session) {
						// Recover the session for the next message, or drop it.
						try {
							await session.command("RSET", [250]);
						} catch {
							await session.close();
							session = null;
						}
					}
					// Auth/config failures will fail every message: stop early.
					if (!e.retryable && !e.permanentRecipient && /SMTP_5(30|34|35)|E_AUTH|E_NO_STARTTLS/.test(e.code)) {
						for (let i = results.length; i < messages.length; i++) results.push({ ok: false, error: e });
						break;
					}
				}
			}
		} finally {
			await session?.close();
		}
		return results;
	}

	return {
		name: provider,
		maxBatch: 50,
		async send(msg) {
			const [r] = await sendBatch([msg]);
			if (!r.ok) throw r.error;
			return { messageId: r.messageId };
		},
		sendBatch,
		async verify() {
			try {
				const s = await open(config.username?.includes("@") ? config.username : `verify@${config.clientName ?? "localhost"}`);
				await s.close();
				return { ok: true, detail: `Connected to ${config.host}:${config.port}${config.username ? " and authenticated" : ""}` };
			} catch (err) {
				return { ok: false, detail: (err as Error).message };
			}
		},
	};
}
