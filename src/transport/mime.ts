import { b64, utf8 } from "../util.ts";
import { formatAddress, type OutboundEmail, toAddress, toList } from "./types.ts";

/** RFC 2047 encoded-word for non-ASCII header text. */
export function encodeHeaderText(s: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: header safety
	const clean = s.replace(/[\r\n]+/g, " ");
	if (/^[\x20-\x7e]*$/.test(clean)) return clean;
	// Split into chunks so each encoded word stays under 75 chars.
	const words: string[] = [];
	let chunk = "";
	for (const ch of clean) {
		if (utf8.encode(chunk + ch).length > 45) {
			words.push(chunk);
			chunk = "";
		}
		chunk += ch;
	}
	if (chunk) words.push(chunk);
	return words.map((w) => `=?UTF-8?B?${b64.encode(utf8.encode(w))}?=`).join("\r\n ");
}

function encodeMailbox(a: Parameters<typeof toAddress>[0]): string {
	const { email, name } = toAddress(a);
	if (!name) return `<${email}>`;
	const n = encodeHeaderText(name);
	return n.startsWith("=?") ? `${n} <${email}>` : formatAddress({ email, name });
}

function wrapBase64(s: string): string {
	return s.replace(/.{1,76}/g, "$&\r\n");
}

/**
 * Builds an RFC 5322 multipart/alternative message (text + HTML) for SMTP.
 * Bodies are base64 so any UTF-8 content and long lines are safe.
 */
export function buildMime(msg: OutboundEmail, opts: { messageId: string; date?: Date }): string {
	const boundary = `=_nl_${crypto.randomUUID().replace(/-/g, "")}`;
	const to = toList(msg.to);
	const headers: [string, string][] = [
		["From", encodeMailbox(msg.from)],
		["To", to.map(encodeMailbox).join(", ")],
		["Subject", encodeHeaderText(msg.subject)],
		["Date", (opts.date ?? new Date()).toUTCString().replace("GMT", "+0000")],
		["Message-ID", opts.messageId],
		["MIME-Version", "1.0"],
	];
	if (msg.replyTo) headers.push(["Reply-To", encodeMailbox(msg.replyTo)]);
	const reserved = new Set(["from", "to", "subject", "date", "message-id", "mime-version", "reply-to", "content-type"]);
	for (const [k, v] of Object.entries(msg.headers ?? {})) {
		if (!/^[A-Za-z0-9-]+$/.test(k) || reserved.has(k.toLowerCase())) continue;
		headers.push([k, v.replace(/[\r\n]+/g, " ")]);
	}
	if (msg.idempotencyKey) headers.push(["X-Bird-Idempotency-Key", msg.idempotencyKey]);
	headers.push(["Content-Type", `multipart/alternative; boundary="${boundary}"`]);

	const part = (type: string, body: string) =>
		`--${boundary}\r\nContent-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrapBase64(b64.encode(utf8.encode(body)))}`;

	return `${headers.map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n${part("text/plain", msg.text)}${part("text/html", msg.html)}--${boundary}--\r\n`;
}
