import assert from "node:assert/strict";
import { test } from "node:test";
import { createTransport } from "../src/transport/factory.ts";
import { birdTransport, mailgunTransport, postmarkTransport } from "../src/transport/http.ts";
import { buildMime, encodeHeaderText } from "../src/transport/mime.ts";
import { type SmtpSocket, type SocketConnect, smtpTransport } from "../src/transport/smtp.ts";
import { b64 } from "../src/util.ts";

/** Scripted SMTP server. Records the session; `respond` decides replies. */
function fakeSmtp(opts: { starttls?: boolean; rejectRcpt?: string; authFail?: boolean } = {}) {
	const log: string[] = [];
	const messages: string[] = [];
	let tlsActive = false;
	let opened = 0;
	const connect: SocketConnect = (_addr, options) => {
		opened++;
		tlsActive = options.secureTransport === "on";
		let push!: (s: string) => void;
		let inData = false;
		let dataBuf = "";
		const make = (): SmtpSocket => {
			const readable = new ReadableStream<Uint8Array>({
				start(c) {
					push = (s) => c.enqueue(new TextEncoder().encode(s));
				},
			});
			let pending = "";
			const writable = new WritableStream<Uint8Array>({
				write(chunk) {
					pending += new TextDecoder().decode(chunk);
					let i: number;
					while ((i = pending.indexOf("\r\n")) >= 0) {
						const line = pending.slice(0, i);
						pending = pending.slice(i + 2);
						if (inData) {
							if (line === ".") {
								inData = false;
								messages.push(dataBuf);
								dataBuf = "";
								push("250 2.0.0 Ok: queued as em_test123\r\n");
							} else dataBuf += `${line}\r\n`;
							continue;
						}
						log.push(line);
						const cmd = line.split(" ")[0].toUpperCase();
						if (cmd === "EHLO") {
							const caps = ["250-hello", "250-8BITMIME"];
							if (opts.starttls && !tlsActive) caps.push("250-STARTTLS");
							if (tlsActive || !opts.starttls) caps.push("250-AUTH PLAIN LOGIN");
							caps.push("250 SIZE 1000");
							push(`${caps.join("\r\n")}\r\n`);
						} else if (cmd === "STARTTLS") push("220 ready\r\n");
						else if (cmd === "AUTH") push(opts.authFail ? "535 5.7.8 bad credentials\r\n" : "235 ok\r\n");
						else if (cmd === "MAIL") push("250 ok\r\n");
						else if (cmd === "RCPT") push(opts.rejectRcpt && line.includes(opts.rejectRcpt) ? "550 5.1.1 no such user\r\n" : "250 ok\r\n");
						else if (cmd === "DATA") {
							inData = true;
							push("354 go\r\n");
						} else if (cmd === "RSET") push("250 ok\r\n");
						else if (cmd === "QUIT") push("221 bye\r\n");
						else push("502 unknown\r\n");
					}
				},
			});
			return {
				readable,
				writable,
				startTls() {
					tlsActive = true;
					return make();
				},
				close() {},
			};
		};
		const s = make();
		queueMicrotask(() => push("220 smtp.test ESMTP\r\n"));
		return s;
	};
	return { connect, log, messages, opened: () => opened };
}

const msg = (to: string, extra: Record<string, unknown> = {}) => ({
	from: { email: "news@mail.example.test", name: "Test Daily" },
	to,
	subject: "Héllo — résumé tips",
	html: "<p>Hi</p>\n.dot line",
	text: "Hi\n.dot line",
	headers: { "List-Unsubscribe": "<https://x.test/u>" },
	metadata: { nl_outbox_id: "ob_1" },
	...extra,
});

test("SMTP: STARTTLS, AUTH PLAIN, one connection for a batch, dot-stuffing, queued id", async () => {
	const server = fakeSmtp({ starttls: true });
	const t = smtpTransport({ host: "smtp.test", port: 587, security: "starttls", username: "bird", password: "bk_us1_key", connect: server.connect });
	const results = await t.sendBatch([msg("a@example.org"), msg("b@example.org")]);
	assert.deepEqual(results.map((r) => r.ok), [true, true]);
	assert.equal(results[0].ok && results[0].messageId, "em_test123");
	assert.equal(server.opened(), 1, "batch reuses one connection");
	const cmds = server.log.map((l) => l.split(" ")[0]);
	assert.deepEqual(cmds.slice(0, 4), ["EHLO", "STARTTLS", "EHLO", "AUTH"]);
	const auth = server.log.find((l) => l.startsWith("AUTH PLAIN"))!.split(" ")[2];
	assert.equal(new TextDecoder().decode(b64.decode(auth)), "\u0000bird\u0000bk_us1_key");
	assert.equal(server.messages.length, 2);
	assert.match(server.messages[0], /Subject: =\?UTF-8\?B\?/);
	assert.match(server.messages[0], /List-Unsubscribe: <https:\/\/x\.test\/u>/);
	assert.match(server.messages[0], /Message-ID: <ob_1@mail\.example\.test>/);
	assert.match(server.messages[0], /multipart\/alternative/);
});

test("SMTP: rejected recipient is a permanent recipient error; the batch continues", async () => {
	const server = fakeSmtp({ rejectRcpt: "bad@" });
	const t = smtpTransport({ host: "smtp.test", port: 465, security: "tls", username: "u", password: "p", connect: server.connect });
	const r = await t.sendBatch([msg("bad@example.org"), msg("good@example.org")]);
	assert.equal(r[0].ok, false);
	assert.equal(!r[0].ok && r[0].error.permanentRecipient, true);
	assert.equal(r[1].ok, true);
	assert.ok(server.log.includes("RSET"));
});

test("SMTP: bad credentials fail the whole batch without retry", async () => {
	const server = fakeSmtp({ authFail: true });
	const t = smtpTransport({ host: "smtp.test", port: 465, security: "tls", username: "u", password: "p", connect: server.connect });
	const r = await t.sendBatch([msg("a@example.org"), msg("b@example.org")]);
	assert.ok(r.every((x) => !x.ok && !x.error.retryable));
	assert.equal(server.messages.length, 0);
});

test("SMTP: refuses credentials over plaintext", () => {
	assert.throws(() => smtpTransport({ host: "h", port: 25, security: "none", username: "u", password: "p" }));
});

test("SMTP presets: Bird preset fills host, port and username", async () => {
	const server = fakeSmtp();
	const t = createTransport({ type: "smtp", smtpPreset: "bird-eu", password: "bk_eu1_x" }, { connect: server.connect });
	assert.equal(t.name, "bird-smtp");
	await t.send(msg("a@example.org"));
	assert.ok(server.log.some((l) => l.startsWith("AUTH PLAIN")));
});

function fakeFetch(respond: (url: string, init: RequestInit) => Response) {
	const calls: { url: string; init: RequestInit }[] = [];
	const f = async (url: string, init: RequestInit = {}) => {
		calls.push({ url, init });
		return respond(url, init);
	};
	return { f, calls };
}

test("Bird: batches to the key's region, strips our unsubscribe headers for marketing, keeps metadata", async () => {
	const { f, calls } = fakeFetch(() => Response.json({ data: [{ id: "em_a" }, { id: "em_b" }] }, { status: 202 }));
	const t = birdTransport({ apiKey: "bk_eu1_abc", fetch: f });
	const r = await t.sendBatch([msg("a@example.org", { idempotencyKey: "nl/1" }), msg("b@example.org", { idempotencyKey: "nl/2" })]);
	assert.deepEqual(r, [{ ok: true, messageId: "em_a" }, { ok: true, messageId: "em_b" }]);
	assert.equal(calls[0].url, "https://eu1.platform.bird.com/v1/email/batches");
	const headers = calls[0].init.headers as Record<string, string>;
	assert.equal(headers.Authorization, "Bearer bk_eu1_abc");
	assert.ok(headers["Idempotency-Key"]?.startsWith("batch/"));
	const body = JSON.parse(String(calls[0].init.body));
	assert.equal(body.messages.length, 2);
	assert.equal(body.messages[0].category, "marketing");
	assert.equal(body.messages[0].headers, undefined);
	assert.deepEqual(body.messages[0].metadata, { nl_outbox_id: "ob_1" });
	assert.deepEqual(body.messages[0].to, [{ email: "a@example.org" }]);
	assert.equal(body.messages[0].track_opens, false);
});

test("Bird: transactional category keeps List-Unsubscribe; a 422 batch falls back to single sends", async () => {
	let n = 0;
	const { f, calls } = fakeFetch((url) => {
		n++;
		if (url.endsWith("/batches")) return new Response('{"error":"bad item"}', { status: 422 });
		return n === 2 ? new Response("bad", { status: 422 }) : Response.json({ id: `em_${n}` }, { status: 202 });
	});
	const t = birdTransport({ apiKey: "bk_us1_abc", category: "transactional", fetch: f });
	const r = await t.sendBatch([msg("bad@example.org"), msg("good@example.org")]);
	assert.equal(r[0].ok, false);
	assert.equal(r[1].ok, true);
	const single = JSON.parse(String(calls[2].init.body));
	assert.equal(single.headers["List-Unsubscribe"], "<https://x.test/u>");
	assert.equal(calls[1].url, "https://us1.platform.bird.com/v1/email/messages");
});

test("Bird: 429 is retryable", async () => {
	const { f } = fakeFetch(() => new Response("slow down", { status: 429 }));
	const r = await birdTransport({ apiKey: "bk_us1_abc", fetch: f }).sendBatch([msg("a@example.org")]);
	assert.equal(!r[0].ok && r[0].error.retryable, true);
});

test("Mailgun: form fields, user variables and EU host", async () => {
	const { f, calls } = fakeFetch(() => Response.json({ id: "<abc@mg>" }));
	const r = await mailgunTransport({ apiKey: "key", domain: "mg.example.test", region: "eu", fetch: f }).send(msg("a@example.org"));
	assert.equal(r.messageId, "abc@mg");
	assert.equal(calls[0].url, "https://api.eu.mailgun.net/v3/mg.example.test/messages");
	const form = calls[0].init.body as FormData;
	assert.equal(form.get("v:nl_outbox_id"), "ob_1");
	assert.equal(form.get("h:List-Unsubscribe"), "<https://x.test/u>");
	assert.equal(form.get("o:tracking"), "no");
});

test("Postmark: per-message results from a batch", async () => {
	const { f } = fakeFetch(() => Response.json([{ ErrorCode: 0, MessageID: "pm1" }, { ErrorCode: 406, Message: "Inactive recipient" }]));
	const r = await postmarkTransport({ serverToken: "t", fetch: f }).sendBatch([msg("a@example.org"), msg("b@example.org")]);
	assert.equal(r[0].ok && r[0].messageId, "pm1");
	assert.equal(!r[1].ok && r[1].error.permanentRecipient, true);
});

test("MIME: encoded headers stay short and bodies are base64", () => {
	const enc = encodeHeaderText("Ünïcödé subject that is quite long and needs folding across several encoded words");
	for (const line of enc.split("\r\n")) assert.ok(line.length <= 76, line);
	const m = buildMime({ from: "a@b.c", to: "d@e.f", subject: "Hi", html: "<b>x</b>", text: "x", headers: { "Bad Header": "x", "X-Ok": "y\r\nInjected: z" } }, { messageId: "<1@b.c>" });
	assert.ok(!/Bad Header/.test(m));
	assert.match(m, /X-Ok: y Injected: z/);
	assert.ok(!/\r\nInjected:/.test(m), "no header injection");
	assert.match(m, /Content-Transfer-Encoding: base64/);
});

test("factory: every provider type builds", () => {
	for (const p of [
		{ type: "bird", apiKey: "bk_us1_x" },
		{ type: "smtp", host: "h", port: 465, security: "tls" },
		{ type: "sparkpost", apiKey: "x" },
		{ type: "mailgun", apiKey: "x", domain: "d" },
		{ type: "postmark", apiKey: "x" },
		{ type: "resend", apiKey: "x" },
		{ type: "sendgrid", apiKey: "x" },
		{ type: "ses", accessKeyId: "a", secretAccessKey: "s", region: "us-east-1" },
	] as const) {
		assert.ok(createTransport(p).name);
	}
	assert.throws(() => createTransport({ type: "bird" }), /API key/);
});
