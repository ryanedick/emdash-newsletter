import assert from "node:assert/strict";
import { test } from "node:test";
import { createNewsletterHandler } from "../src/handler.ts";
import { hmacSha256 } from "../src/crypto.ts";
import { b64 } from "../src/util.ts";
import { activeSubs, linksIn, setup } from "./helpers.ts";

test("double opt-in: subscribe sends a confirmation, the link activates", async () => {
	const { nl, transport } = await setup();
	const r = await nl.subscribers.subscribe({ email: "  Ann@Example.org ", firstName: "Ann", source: "home" });
	assert.equal(r.status, "pending");
	assert.equal(transport.sent.length, 1);
	const mail = transport.sent[0];
	assert.match(mail.subject, /Confirm your subscription to Test Daily/);
	const confirm = linksIn(mail.html).find((l) => l.includes("/newsletter/confirm?t="));
	assert.ok(confirm, "confirmation link present");
	const token = new URL(confirm!).searchParams.get("t");
	const sub = await nl.subscribers.confirmByToken(token);
	assert.equal(sub?.status, "active");
	assert.equal(sub?.email, "ann@example.org");
	// Re-subscribing an active address is a no-op.
	const again = await nl.subscribers.subscribe({ email: "ann@example.org" });
	assert.equal(again.status, "already_active");
	assert.equal(transport.sent.length, 1);
	// A tampered token is rejected.
	assert.equal(await nl.subscribers.confirmByToken(`${token}x`), null);
});

test("stored provider secrets are encrypted at rest", async () => {
	const { db, nl } = await setup();
	const row = db.raw.prepare("SELECT value FROM nl_settings WHERE key = 'config'").get() as { value: string };
	assert.ok(!row.value.includes("bk_us1_secretkey"));
	assert.match(row.value, /enc:v1:/);
	assert.equal((await nl.settings.get()).provider?.apiKey, "bk_us1_secretkey");
	// Saving without the secret keeps it.
	await nl.settings.update({ provider: { type: "bird", apiKey: "", birdCategory: "transactional" } });
	const c = await nl.settings.get();
	assert.equal(c.provider?.apiKey, "bk_us1_secretkey");
	assert.equal(c.provider?.birdCategory, "transactional");
});

test("campaign: fan-out, personalisation, tracking, unsubscribe headers, completion", async () => {
	const { nl, transport } = await setup();
	await activeSubs(nl, 5);
	await nl.subscribers.subscribe({ email: "pending@example.org" }); // pending: must not receive
	transport.sent.length = 0;
	const c = await nl.campaigns.createCampaign({
		subject: "Hello {{first_name|friend}}",
		preheader: "Today's tip",
		content: "# Big news\n\nHi {{first_name|there}}, read [the post](https://example.test/post).\n\n[[Open it]](https://example.test/post)",
	});
	const started = await nl.campaigns.startCampaign(c.id);
	assert.equal(started.status, "sending");
	assert.equal(started.recipientsTotal, 5);
	const tick = await nl.tick();
	assert.equal(tick.outbox.sent, 5);
	assert.deepEqual(tick.campaigns.finished, [c.id]);
	assert.equal(transport.sent.length, 5);
	const m = transport.sent.find((x) => JSON.stringify(x.to).includes("reader2@"))!;
	assert.equal(m.subject, "Hello R2");
	assert.match(m.html, /Hi R2, read/);
	assert.match(m.headers!["List-Unsubscribe"], /^<https:\/\/example\.test\/newsletter\/u\?t=/);
	assert.equal(m.headers!["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
	assert.match(m.html, /1 Test St, Testville/);
	assert.match(m.text, /Unsubscribe: https:\/\/example\.test\/newsletter\/u\?t=/);
	assert.match(m.html, /\/newsletter\/o\/ob_[a-z0-9]+\.[A-Za-z0-9_-]+\.gif/);
	assert.ok(!m.html.includes('href="https://example.test/post"'), "content links are tracked");
	assert.equal(m.metadata?.nl_campaign_id, c.id);

	// Click → original URL, recorded once per outbox for uniques.
	const click = linksIn(m.html).find((l) => l.includes("/newsletter/c/"))!;
	const dest = await nl.events.recordClick(click.split("/newsletter/c/")[1]);
	assert.equal(dest, "https://example.test/post");
	const stats = await nl.analytics.campaignStats(c.id);
	assert.equal(stats.sent, 5);
	assert.equal(stats.uniqueClicks, 1);
	assert.equal(stats.uniqueOpens, 1, "a click implies an open");
	assert.equal((await nl.campaigns.getCampaign(c.id))?.status, "sent");

	// Sending again is refused; nobody gets a duplicate.
	await assert.rejects(nl.campaigns.startCampaign(c.id));
});

test("unsubscribe link and RFC 8058 one-click both work; unsubscribed readers are skipped", async () => {
	const { nl, transport } = await setup();
	const [a, b] = await activeSubs(nl, 2);
	const handler = createNewsletterHandler(nl);
	const c = await nl.campaigns.createCampaign({ subject: "One", content: "Hello" });
	await nl.campaigns.startCampaign(c.id);
	await nl.tick();
	const mailA = transport.sent.find((x) => JSON.stringify(x.to).includes(a.email))!;
	const unsub = mailA.headers!["List-Unsubscribe"].slice(1, -1);
	// GET shows a confirmation page, doesn't unsubscribe (link scanners).
	const get = await handler(new Request(unsub));
	assert.equal(get.status, 200);
	assert.match(await get.text(), /Unsubscribe\?/);
	assert.equal((await nl.subscribers.getSubscriber(a.id))?.status, "active");
	// Mailbox provider one-click POST.
	const post = await handler(new Request(unsub, { method: "POST", body: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } }));
	assert.equal(post.status, 200);
	assert.equal((await nl.subscribers.getSubscriber(a.id))?.status, "unsubscribed");

	transport.sent.length = 0;
	const c2 = await nl.campaigns.createCampaign({ subject: "Two", content: "Again" });
	await nl.campaigns.startCampaign(c2.id);
	await nl.tick();
	assert.equal(transport.sent.length, 1);
	assert.ok(JSON.stringify(transport.sent[0].to).includes(b.email));
});

test("segments and topics target the right readers", async () => {
	const { nl, transport } = await setup();
	await nl.subscribers.saveTopic({ slug: "deals", name: "Deals", isDefault: false });
	const subs = await activeSubs(nl, 6);
	await nl.subscribers.addTags(subs[0].id, ["vip"]);
	await nl.subscribers.addTags(subs[1].id, ["vip", "topic:deals"]);
	await nl.subscribers.updateSubscriber(subs[2].id, { attributes: { plan: "pro" } });
	const seg = await nl.segments.createSegment({ name: "VIPs", rules: { match: "all", conditions: [{ field: "tag", op: "has", value: "vip" }] } });
	assert.equal(await nl.segments.countAudience({ segmentId: seg.id }), 2);
	assert.equal(await nl.segments.countAudience({ segmentId: seg.id, topic: "deals" }), 1);
	assert.equal(await nl.segments.countAudience({ rules: { match: "all", conditions: [{ field: "attr.plan", op: "eq", value: "pro" }] } }), 1);
	assert.equal(await nl.segments.countAudience({ rules: { match: "any", conditions: [{ field: "tag", op: "has", value: "vip" }, { field: "attr.plan", op: "eq", value: "pro" }] } }), 3);
	transport.sent.length = 0;
	const c = await nl.campaigns.createCampaign({ subject: "VIP only", content: "Shh", segmentId: seg.id });
	await nl.campaigns.startCampaign(c.id);
	await nl.tick();
	assert.equal(transport.sent.length, 2);
});

test("A/B subject test sends to a sample, then the winner goes to everyone else", async () => {
	const { db, nl, transport } = await setup();
	await activeSubs(nl, 40);
	transport.sent.length = 0;
	const c = await nl.campaigns.createCampaign({ subject: "Subject A", subjectB: "Subject B", abTestPct: 25, abWaitMinutes: 60, content: "Hi [x](https://example.test/x)" });
	const started = await nl.campaigns.startCampaign(c.id);
	assert.equal(started.status, "testing");
	await nl.tick();
	const testSize = transport.sent.length;
	assert.equal(testSize, 20); // 25% per variant = 50% of 40
	const subjects = new Set(transport.sent.map((m) => m.subject));
	assert.ok(subjects.has("Subject A") || subjects.has("Subject B"));
	// B readers click.
	for (const m of transport.sent.filter((x) => x.subject === "Subject B")) {
		const link = linksIn(m.html).find((l) => l.includes("/newsletter/c/"))!;
		await nl.events.recordClick(link.split("/newsletter/c/")[1]);
	}
	db.raw.prepare("UPDATE nl_campaigns SET ab_decide_at = 0").run();
	await nl.tick();
	const after = await nl.campaigns.getCampaign(c.id);
	assert.equal(after?.abWinner, transport.sent.some((m) => m.subject === "Subject B") ? "b" : "a");
	assert.equal(transport.sent.length, 40, "everyone got exactly one email");
	const rest = transport.sent.slice(testSize);
	assert.ok(rest.every((m) => m.subject === (after?.abWinner === "b" ? "Subject B" : "Subject A")));
	assert.equal(after?.status, "sent");
});

test("Bird webhook: signed hard bounce suppresses the reader", async () => {
	const { nl, transport } = await setup();
	const secretBytes = new TextEncoder().encode("bird-webhook-secret-bytes");
	await nl.settings.update({ webhookSecrets: { bird: `whsec_${b64.encode(secretBytes)}` } });
	const [a] = await activeSubs(nl, 1);
	const c = await nl.campaigns.createCampaign({ subject: "X", content: "Y" });
	await nl.campaigns.startCampaign(c.id);
	await nl.tick();
	const outboxId = transport.sent[0].metadata!.nl_outbox_id;
	const body = JSON.stringify({ type: "email.bounced", timestamp: new Date().toISOString(), data: { email_id: "em_1", recipient: a.email, bounce_type: "hard", metadata: { nl_outbox_id: outboxId } } });
	const id = "msg_abc";
	const ts = String(Math.floor(Date.now() / 1000));
	const sig = b64.encode(await hmacSha256(secretBytes, `${id}.${ts}.${body}`));
	const handler = createNewsletterHandler(nl);
	const bad = await handler(new Request("https://example.test/newsletter/webhooks/bird", { method: "POST", body, headers: { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": "v1,AAAA" } }));
	assert.equal(bad.status, 401);
	const ok = await handler(new Request("https://example.test/newsletter/webhooks/bird", { method: "POST", body, headers: { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` } }));
	assert.equal(ok.status, 200);
	assert.equal((await ok.json()).processed, 1);
	assert.equal((await nl.subscribers.getSubscriber(a.id))?.status, "bounced");
	// Replays are ignored.
	const replay = await handler(new Request("https://example.test/newsletter/webhooks/bird", { method: "POST", body, headers: { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` } }));
	assert.equal((await replay.json()).ignored, 1);
	assert.equal((await nl.analytics.campaignStats(c.id)).bounced, 1);
});

test("generic webhook requires the ?key token", async () => {
	const { nl } = await setup();
	const [a] = await activeSubs(nl, 1);
	const handler = createNewsletterHandler(nl);
	const body = JSON.stringify({ events: [{ type: "complained", email: a.email }] });
	assert.equal((await handler(new Request("https://example.test/newsletter/webhooks/generic", { method: "POST", body }))).status, 401);
	const url = await nl.webhookUrl("generic");
	const res = await handler(new Request(url, { method: "POST", body }));
	assert.equal(res.status, 200);
	assert.equal((await nl.subscribers.getSubscriber(a.id))?.status, "complained");
});

test("automation: welcome sequence runs on confirmation with delays", async () => {
	const { db, nl, transport } = await setup();
	await nl.automations.saveAutomation({
		name: "Welcome",
		trigger: "subscribed",
		status: "active",
		steps: [
			{ delayHours: 0, subject: "Welcome {{first_name|there}}", content: "Start here." },
			{ delayHours: 48, subject: "Our best tips", content: "Day 2." },
		],
	});
	const [s] = await activeSubs(nl, 1);
	transport.sent.length = 0;
	await nl.tick();
	assert.deepEqual(transport.sent.map((m) => m.subject), ["Welcome R0"]);
	await nl.tick();
	assert.equal(transport.sent.length, 1, "second step waits 48h");
	db.raw.prepare("UPDATE nl_automation_runs SET next_at = 0").run();
	await nl.tick();
	assert.deepEqual(transport.sent.map((m) => m.subject), ["Welcome R0", "Our best tips"]);
	const run = db.raw.prepare("SELECT status FROM nl_automation_runs WHERE subscriber_id = ?").get(s.id) as { status: string };
	assert.equal(run.status, "done");
});

test("referrals: confirmed referrals unlock milestones once", async () => {
	const hits: number[] = [];
	const { nl } = await setup({ hooks: { onReferralMilestone: (_r, m) => void hits.push(m.count) } });
	await nl.settings.update({ referrals: { enabled: true, milestones: [{ count: 2, reward: "a sticker" }] } });
	const [ref] = await activeSubs(nl, 1);
	for (const e of ["f1@example.org", "f2@example.org", "f3@example.org"]) await nl.subscribers.subscribe({ email: e, ref: ref.referralCode, confirmed: true });
	assert.deepEqual(hits, [2]);
	const tags = (await nl.subscribers.getSubscriber(ref.id, true))?.tags;
	assert.ok(tags?.includes("referral:2"));
});

test("transient send errors retry with backoff; permanent recipient errors bounce", async () => {
	const { db, nl, transport } = await setup();
	const [a, b] = await activeSubs(nl, 2);
	const { EmailSendError } = await import("../src/transport/types.ts");
	transport.failNext = (m) => {
		const to = JSON.stringify(m.to);
		if (to.includes(a.email)) return { ok: false, error: new EmailSendError("fake", "HTTP_503", "down", { retryable: true }) };
		if (to.includes(b.email)) return { ok: false, error: new EmailSendError("fake", "SMTP_550", "no such user", { retryable: false, permanentRecipient: true }) };
	};
	const c = await nl.campaigns.createCampaign({ subject: "S", content: "C" });
	await nl.campaigns.startCampaign(c.id);
	const r = await nl.tick();
	assert.equal(r.outbox.retried, 1);
	assert.equal(r.outbox.failed, 1);
	assert.equal((await nl.subscribers.getSubscriber(b.id))?.status, "bounced");
	transport.failNext = undefined;
	db.raw.prepare("UPDATE nl_outbox SET next_attempt_at = 0 WHERE status = 'queued'").run();
	const r2 = await nl.tick();
	assert.equal(r2.outbox.sent, 1);
	assert.equal((await nl.campaigns.getCampaign(c.id))?.status, "sent");
});

test("send rate limit spreads a big send over minutes", async () => {
	const { nl, transport } = await setup();
	await nl.settings.update({ sendRatePerMinute: 7 });
	await activeSubs(nl, 10);
	transport.sent.length = 0;
	const c = await nl.campaigns.createCampaign({ subject: "S", content: "C" });
	await nl.campaigns.startCampaign(c.id);
	const r = await nl.tick();
	assert.equal(r.outbox.sent, 7);
	assert.equal(r.outbox.rateLimited, true);
});

test("publish → email: content entries become issues once", async () => {
	const { nl, transport } = await setup();
	await nl.settings.update({ autoSend: { collection: "tips", mode: "send", extraFields: ["prompts"], urlPattern: "/tips/{slug}" } });
	await activeSubs(nl, 3);
	transport.sent.length = 0;
	const entry = {
		collection: "tips",
		id: "tip-1",
		slug: "first-tip",
		data: {
			title: "Make AI interview you",
			excerpt: "Ask questions first.",
			content: [{ _type: "block", style: "normal", children: [{ _type: "span", text: "Body text here", marks: ["strong"] }], markDefs: [] }],
			prompts: [{ label: "Starter", prompt: "Ask me 5 questions" }],
		},
	};
	const r = await nl.content.campaignFromContent(entry);
	assert.equal(r.action, "sent");
	const again = await nl.content.campaignFromContent(entry);
	assert.equal(again.action, "exists");
	await nl.tick();
	assert.equal(transport.sent.length, 3);
	const m = transport.sent[0];
	assert.equal(m.subject, "Make AI interview you");
	assert.match(m.html, /<strong>Body text here<\/strong>/);
	assert.match(m.html, /Ask me 5 questions/);
	assert.match(m.text, /Read on the site/);
	// Other collections are ignored.
	assert.equal((await nl.content.campaignFromContent({ ...entry, collection: "pages", id: "p1" })).action, "skipped");
	// It's in the web archive.
	const handler = createNewsletterHandler(nl);
	const page = await handler(new Request("https://example.test/newsletter/p/first-tip"));
	assert.equal(page.status, 200);
	assert.match(await page.text(), /Body text here/);
});

test("publish → email: a future send-at date schedules the issue instead of sending now", async () => {
	const { nl, transport } = await setup();
	await nl.settings.update({ autoSend: { collection: "tips", mode: "send", sendAtField: "issue_date", urlPattern: "/tips/{slug}" } });
	await activeSubs(nl, 2);
	transport.sent.length = 0;
	const at = Date.now() + 10 * 3600_000;
	const future = { collection: "tips", id: "tip-f", slug: "tomorrow", data: { title: "Tomorrow", excerpt: "x", issue_date: new Date(at).toISOString() } };
	const r = await nl.content.campaignFromContent(future);
	assert.equal(r.action, "scheduled");
	assert.equal("campaign" in r && r.campaign.scheduledAt, at);
	await nl.tick();
	assert.equal(transport.sent.length, 0);
	// Re-publishing with a new date moves the schedule.
	const later = at + 3600_000;
	const moved = await nl.content.campaignFromContent({ ...future, data: { ...future.data, issue_date: new Date(later).toISOString() } });
	assert.equal("campaign" in moved && moved.campaign.scheduledAt, later);
	// A date already past sends right away.
	const past = { ...future, id: "tip-p", slug: "today", data: { ...future.data, issue_date: new Date(Date.now() - 3600_000).toISOString() } };
	assert.equal((await nl.content.campaignFromContent(past)).action, "sent");
});

test("public subscribe endpoint: honeypot, validation, JSON and referral cookie", async () => {
	const { nl, transport } = await setup();
	const handler = createNewsletterHandler(nl);
	const [ref] = await activeSubs(nl, 1);
	const r1 = await handler(new Request(`https://example.test/newsletter/r/${ref.referralCode}`));
	assert.equal(r1.status, 302);
	const cookie = r1.headers.get("set-cookie")!.split(";")[0];
	const form = new FormData();
	form.set("email", "new@example.org");
	form.set("source", "footer");
	const res = await handler(new Request("https://example.test/newsletter/subscribe", { method: "POST", body: form, headers: { accept: "application/json", cookie, "cf-connecting-ip": "1.2.3.4" } }));
	const json = await res.json();
	assert.equal(json.ok, true);
	assert.equal(json.status, "pending");
	const sub = await nl.subscribers.getSubscriberByEmail("new@example.org");
	assert.equal(sub?.referredBy, ref.id);
	assert.equal(sub?.source, "footer");
	const bot = new FormData();
	bot.set("email", "bot@example.org");
	bot.set("website", "spam");
	await handler(new Request("https://example.test/newsletter/subscribe", { method: "POST", body: bot, headers: { accept: "application/json" } }));
	assert.equal(await nl.subscribers.getSubscriberByEmail("bot@example.org"), null);
	const bad = await handler(new Request("https://example.test/newsletter/subscribe", { method: "POST", body: JSON.stringify({ email: "nope" }), headers: { "content-type": "application/json" } }));
	assert.equal(bad.status, 400);
	assert.ok(transport.sent.some((m) => m.subject.startsWith("Confirm")));
});

test("preference center updates topics and name", async () => {
	const { nl, transport } = await setup();
	await nl.subscribers.saveTopic({ slug: "daily", name: "Daily tip" });
	await nl.subscribers.saveTopic({ slug: "weekly", name: "Weekly roundup" });
	const [s] = await activeSubs(nl, 1);
	assert.deepEqual((await nl.subscribers.getSubscriber(s.id, true))?.tags?.sort(), ["topic:daily", "topic:weekly"]);
	const c = await nl.campaigns.createCampaign({ subject: "S", content: "C" });
	await nl.campaigns.startCampaign(c.id);
	await nl.tick();
	const prefs = linksIn(transport.sent.at(-1)!.html).find((l) => l.includes("/preferences?t="))!;
	const handler = createNewsletterHandler(nl);
	const body = new URLSearchParams([["first_name", "Rae"], ["topics", "weekly"]]);
	const res = await handler(new Request(prefs, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } }));
	assert.equal(res.status, 200);
	const after = await nl.subscribers.getSubscriber(s.id, true);
	assert.equal(after?.firstName, "Rae");
	assert.deepEqual(after?.tags, ["topic:weekly"]);
});

test("CSV import and export round-trip, with formula injection neutralised", async () => {
	const { nl } = await setup();
	const res = await nl.subscribers.importCsv('email,first_name,tags,company\nA@x.org,Al,vip;beta,Acme\nbad-email,Bo,,\n"c@x.org","=cmd",,"Big, Co"\n');
	assert.deepEqual(res, { added: 2, updated: 0, invalid: 1, total: 3 });
	const a = await nl.subscribers.getSubscriberByEmail("a@x.org", true);
	assert.equal(a?.status, "active");
	assert.deepEqual(a?.tags?.sort(), ["beta", "vip"]);
	assert.equal(a?.attributes.company, "Acme");
	const csv = await nl.subscribers.exportCsv();
	assert.match(csv, /^email,status,/);
	assert.match(csv, /'=cmd/);
});

test("GDPR delete removes the subscriber and anonymises history", async () => {
	const { db, nl } = await setup();
	const [s] = await activeSubs(nl, 1);
	const c = await nl.campaigns.createCampaign({ subject: "S", content: "C" });
	await nl.campaigns.startCampaign(c.id);
	await nl.tick();
	assert.equal(await nl.subscribers.deleteSubscriber(s.id), true);
	assert.equal(await nl.subscribers.getSubscriber(s.id), null);
	const left = db.raw.prepare("SELECT COUNT(*) AS n FROM nl_outbox WHERE email = ?").get(s.email) as { n: number };
	assert.equal(left.n, 0);
});
