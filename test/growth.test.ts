import assert from "node:assert/strict";
import { test } from "node:test";
import { handleAdmin } from "../src/plugin/admin.ts";
import { dateInZone } from "../src/util.ts";
import { activeSubs, setup } from "./helpers.ts";

const admin = { role: 50 };
const today = () => dateInZone(Date.now(), "UTC");

const ad = (date: string) => ({
	date,
	sponsor: "Acme AI",
	headline: "Ship agents in an afternoon",
	body: "Acme gives you hosted tools your agents can call.",
	url: "https://acme.example/?utm_source=newsletter",
	ctaLabel: "Try Acme free",
	priceCents: 25000,
});

async function issue(nl: Awaited<ReturnType<typeof setup>>["nl"], id = "tip-1") {
	return nl.content.campaignFromContent({
		collection: "tips",
		id,
		slug: id,
		data: { title: `Tip ${id}`, excerpt: "Excerpt", content: [{ _type: "block", style: "normal", children: [{ _type: "span", text: "Body" }], markDefs: [] }] },
	});
}

test("sponsor slots: one live booking per date, cancel frees it, bad input is rejected", async () => {
	const { nl } = await setup();
	const a = await nl.sponsors.bookSponsorSlot(ad("2026-12-01"));
	assert.ok(a.ok);
	const clash = await nl.sponsors.bookSponsorSlot({ ...ad("2026-12-01"), sponsor: "Other" });
	assert.equal(clash.ok, false);
	assert.equal(!clash.ok && clash.reason, "date_taken");
	// A hold also reserves the date.
	const hold = await nl.sponsors.bookSponsorSlot({ ...ad("2026-12-02"), status: "hold" });
	assert.ok(hold.ok);
	assert.equal((await nl.sponsors.bookSponsorSlot(ad("2026-12-02"))).ok, false);
	// Canceling frees the date.
	await nl.sponsors.cancelSponsorSlot(a.ok ? a.slot.id : "");
	assert.ok((await nl.sponsors.bookSponsorSlot({ ...ad("2026-12-01"), sponsor: "Other" })).ok);
	// Validation
	for (const bad of [{ date: "12/01/2026" }, { url: "javascript:alert(1)" }, { headline: " " }, { imageUrl: "http://insecure.example/x.png" }]) {
		const r = await nl.sponsors.bookSponsorSlot({ ...ad("2026-12-09"), ...bad });
		assert.equal(!r.ok && r.reason, "invalid", JSON.stringify(bad));
	}
	const cal = await nl.sponsors.sponsorCalendar("2026-11-30", 4);
	assert.deepEqual(
		cal.map((d) => [d.date, d.slot?.sponsor ?? null, d.slot?.status ?? null]),
		[
			["2026-11-30", null, null],
			["2026-12-01", "Other", "booked"],
			["2026-12-02", "Acme AI", "hold"],
			["2026-12-03", null, null],
		],
	);
});

test("sponsor ad: shown in the day's auto issue, hidden for tagged readers, tracked, credited", async () => {
	const { nl, transport } = await setup();
	await nl.settings.update({
		autoSend: { collection: "tips", mode: "send" },
		sponsors: { enabled: true, label: "Today's sponsor", hideForTags: ["plan:pro"] },
	});
	const [free] = await activeSubs(nl, 1);
	const [pro] = (await nl.subscribers.subscribe({ email: "pro@example.org", confirmed: true, tags: ["plan:pro"] }).then((r) => ("subscriber" in r ? [r.subscriber] : [])));
	const booked = await nl.sponsors.bookSponsorSlot(ad(today()));
	assert.ok(booked.ok);
	transport.sent.length = 0;

	const r = await issue(nl);
	assert.equal(r.action, "sent");
	await nl.tick();
	assert.equal(transport.sent.length, 2);
	const toFree = transport.sent.find((m) => JSON.stringify(m.to).includes(free.email))!;
	const toPro = transport.sent.find((m) => JSON.stringify(m.to).includes(pro.email))!;
	assert.match(toFree.html, /TODAY&#39;S SPONSOR|Today&#39;s sponsor/i);
	assert.match(toFree.html, /Ship agents in an afternoon/);
	assert.match(toFree.text, /Try Acme free: https:\/\/acme\.example\/\?utm_source=newsletter/);
	assert.doesNotMatch(toPro.html, /Acme/);
	assert.doesNotMatch(toPro.text, /Acme/);
	// The sponsor's link goes through click tracking like any other link.
	assert.doesNotMatch(toFree.html, /href="https:\/\/acme\.example/);
	// The slot remembers the campaign that carried it.
	const slot = await nl.sponsors.getSponsorSlot(booked.ok ? booked.slot.id : "");
	assert.equal(slot?.campaignId, r.action === "sent" ? r.campaign.id : null);
	assert.deepEqual(await nl.sponsors.sponsorClicks(slot!), { clicks: 0, unique: 0 });
});

test("sponsor ad: holds, other dates, one-off campaigns and the off switch show nothing", async () => {
	const { nl, transport } = await setup();
	await nl.settings.update({ autoSend: { collection: "tips", mode: "send" }, sponsors: { enabled: true, hideForTags: ["plan:pro"] } });
	await activeSubs(nl, 1);
	await nl.sponsors.bookSponsorSlot({ ...ad(today()), status: "hold" });
	await nl.sponsors.bookSponsorSlot(ad("2001-01-01"));
	transport.sent.length = 0;
	await issue(nl, "tip-hold");
	await nl.tick();
	assert.doesNotMatch(transport.sent[0].html, /Acme/, "a hold is not shown");

	// Booked today, but a one-off campaign (not auto-sent) doesn't carry it.
	const holdSlot = await nl.sponsors.sponsorForDate(today());
	await nl.sponsors.updateSponsorSlot(holdSlot!.id, { ...ad(today()), status: "booked" });
	const c = await nl.campaigns.createCampaign({ subject: "Announcement", content: "Hello" });
	await nl.campaigns.startCampaign(c.id);
	transport.sent.length = 0;
	await nl.tick();
	assert.doesNotMatch(transport.sent[0].html, /Acme/);

	// The off switch wins.
	await nl.settings.update({ sponsors: { enabled: false } });
	transport.sent.length = 0;
	await issue(nl, "tip-off");
	await nl.tick();
	assert.doesNotMatch(transport.sent[0].html, /Acme/);
});

test("automation exit tag: a reader who gets the tag leaves before the next email", async () => {
	const { db, nl, transport } = await setup();
	const a = await nl.automations.saveAutomation({
		name: "Welcome",
		trigger: "subscribed",
		status: "active",
		exitTag: "plan:pro",
		steps: [
			{ delayHours: 0, subject: "One", content: "1" },
			{ delayHours: 24, subject: "Two (Pro offer)", content: "2" },
		],
	});
	assert.equal(a.exitTag, "plan:pro");
	const [s] = await activeSubs(nl, 1);
	transport.sent.length = 0;
	await nl.tick();
	assert.deepEqual(transport.sent.map((m) => m.subject), ["One"]);
	await nl.subscribers.addTags(s.id, ["plan:pro"]);
	db.raw.prepare("UPDATE nl_automation_runs SET next_at = 0").run();
	await nl.tick();
	assert.deepEqual(transport.sent.map((m) => m.subject), ["One"]);
	const stats = await nl.automations.automationStats(a.id);
	assert.equal(stats.exited, 1);
	assert.equal(stats.active, 0);
});

test("admin: book a sponsor, see it listed, edit, cancel; sponsor settings save", async () => {
	const { nl } = await setup();
	const page = await handleAdmin(nl, { type: "page_load", page: "/sponsors" }, admin);
	assert.equal(page.toast, undefined, page.toast?.message ?? "");
	const booked = await handleAdmin(
		nl,
		{
			type: "form_submit",
			action_id: "sponsor:book",
			values: { date: "2030-03-04", status: "booked", sponsor: "Acme AI", headline: "Hi", url: "https://acme.example", price: "$250" },
		},
		admin,
	);
	assert.equal(booked.toast?.type, "success", booked.toast?.message ?? "");
	const slot = await nl.sponsors.sponsorForDate("2030-03-04");
	assert.equal(slot?.priceCents, 25000);
	// Same date again: error toast, form keeps what was typed.
	const clash = await handleAdmin(nl, { type: "form_submit", action_id: "sponsor:book", values: { date: "2030-03-04", sponsor: "B", headline: "B", url: "https://b.example" } }, admin);
	assert.equal(clash.toast?.type, "error");
	assert.match(JSON.stringify(clash.blocks), /"initial_value":"B"/);
	const editor = await handleAdmin(nl, { type: "block_action", action_id: "sponsor:open", value: slot!.id }, admin);
	assert.match(JSON.stringify(editor.blocks), /Acme AI on 2030-03-04/);
	const canceled = await handleAdmin(nl, { type: "block_action", action_id: `sponsor:cancel:${slot!.id}` }, admin);
	assert.equal(canceled.toast?.type, "success");
	assert.equal(await nl.sponsors.sponsorForDate("2030-03-04"), null);

	const saved = await handleAdmin(nl, { type: "form_submit", action_id: "settings:sponsors", values: { enabled: true, label: "Brought to you by", hide: "plan:pro, vip", autoOnly: true } }, admin);
	assert.equal(saved.toast?.type, "success");
	const c = await nl.settings.get();
	assert.deepEqual(c.sponsors, { enabled: true, label: "Brought to you by", hideForTags: ["plan:pro", "vip"], autoIssuesOnly: true });
});
