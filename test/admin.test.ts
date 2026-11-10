import assert from "node:assert/strict";
import { test } from "node:test";
import { handleAdmin } from "../src/plugin/admin.ts";
import { activeSubs, setup } from "./helpers.ts";

const admin = { role: 50 };

function find(blocks: Record<string, unknown>[], pred: (b: Record<string, unknown>) => boolean): Record<string, unknown> | undefined {
	for (const b of blocks) {
		if (pred(b)) return b;
		for (const nested of [b.blocks, ...((b.panels as { blocks: unknown }[] | undefined)?.map((p) => p.blocks) ?? [])]) {
			if (Array.isArray(nested)) {
				const hit = find(nested as Record<string, unknown>[], pred);
				if (hit) return hit;
			}
		}
	}
}

test("every admin page renders without errors", async () => {
	const { nl } = await setup();
	await activeSubs(nl, 3);
	for (const page of ["/", "/campaigns", "/subscribers", "/audience", "/automations", "/sponsors", "/settings", "widget:newsletter-overview"]) {
		const r = await handleAdmin(nl, { type: "page_load", page }, admin);
		assert.ok(r.blocks.length > 0, page);
		assert.equal(r.toast, undefined, `${page}: ${r.toast?.message}`);
	}
});

test("compose → test → send flow through the admin", async () => {
	const { nl, transport } = await setup();
	await activeSubs(nl, 4);
	transport.sent.length = 0;
	const created = await handleAdmin(nl, { type: "block_action", action_id: "campaign:new", page: "/campaigns" }, admin);
	const formBlock = find(created.blocks, (b) => b.type === "form" && b.block_id === "campaign")!;
	const saveId = (formBlock.submit as { action_id: string }).action_id;
	const id = saveId.split(":")[2];
	const saved = await handleAdmin(
		nl,
		{
			type: "form_submit",
			action_id: saveId,
			values: { subject: "Admin issue", preheader: "pre", content: "Hello {{first_name}}", content_format: "markdown", segment_id: "", topic: "", ab: false, publish_web: true, web_access: "public", track_clicks: true, track_opens: true },
		},
		admin,
	);
	assert.equal(saved.toast?.type, "success", saved.toast?.message ?? "");
	const tested = await handleAdmin(nl, { type: "form_submit", action_id: `campaign:test:${id}`, values: { emails: "me@example.com" } }, admin);
	assert.equal(tested.toast?.type, "success", tested.toast?.message ?? "");
	assert.match(transport.sent[0].subject, /^\[Test\] Admin issue/);
	const preview = await handleAdmin(nl, { type: "block_action", action_id: `campaign:preview:${id}` }, admin);
	assert.ok(find(preview.blocks, (b) => b.type === "code"));
	const sent = await handleAdmin(nl, { type: "block_action", action_id: `campaign:send:${id}` }, admin);
	assert.equal(sent.toast?.type, "success", sent.toast?.message ?? "");
	assert.equal(transport.sent.length, 5);
	const report = await handleAdmin(nl, { type: "block_action", action_id: "campaign:open", value: id }, admin);
	assert.ok(find(report.blocks, (b) => b.type === "stats"));
});

test("settings: provider form saves per-provider fields and keeps secrets", async () => {
	const { nl } = await setup();
	const r = await handleAdmin(
		nl,
		{ type: "form_submit", action_id: "settings:provider", values: { provider_type: "smtp", p_smtp_smtpPreset: "bird-us", p_smtp_password: "bk_us1_pw", p_smtp_host: "", p_smtp_port: "" } },
		admin,
	);
	assert.ok(r.toast, "has toast");
	const c = await nl.settings.get();
	assert.equal(c.provider?.type, "smtp");
	assert.equal(c.provider?.host, "us1.smtp.bird.com");
	assert.equal(c.provider?.port, 465);
	assert.equal(c.provider?.username, "bird");
	assert.equal(c.provider?.password, "bk_us1_pw");
	// Editors can't change settings.
	const denied = await handleAdmin(nl, { type: "form_submit", action_id: "settings:general", values: { publicationName: "Hacked" } }, { role: 40 });
	assert.equal(denied.toast?.type, "error");
	assert.notEqual((await nl.settings.get()).publicationName, "Hacked");
});

test("segments, topics and automations through the admin", async () => {
	const { nl } = await setup();
	const subs = await activeSubs(nl, 3);
	await nl.subscribers.addTags(subs[0].id, ["vip"]);
	const seg = await handleAdmin(nl, { type: "form_submit", action_id: "seg:save:new", values: { name: "VIP", match: "all", rules: "tag has vip" } }, admin);
	assert.match(seg.toast?.message ?? "", /1 active subscribers match/);
	await handleAdmin(nl, { type: "form_submit", action_id: "topic:save", values: { slug: "weekly", name: "Weekly", public: true, default: false } }, admin);
	assert.equal((await nl.subscribers.listTopics())[0].slug, "weekly");
	const auto = await handleAdmin(nl, { type: "block_action", action_id: "auto:new" }, admin);
	const f = find(auto.blocks, (b) => b.type === "form")!;
	const action = (f.submit as { action_id: string }).action_id;
	const saved = await handleAdmin(
		nl,
		{ type: "form_submit", action_id: action, values: { name: "Welcome", trigger: "subscribed", active: true, delay_0: 0, subject_0: "Hi", content_0: "Welcome!", delay_1: 24, subject_1: "Day 2", content_1: "More", delay_2: 24, subject_2: "", content_2: "" } },
		admin,
	);
	assert.equal(saved.toast?.type, "success");
	const list = await nl.automations.listAutomations();
	assert.equal(list[0].status, "active");
	assert.equal(list[0].steps.length, 2);
});
