/**
 * Newsletter admin, rendered as EmDash Block Kit. Every page and button routes
 * through `handleAdmin`. Action ids are `area:verb[:id]`.
 */
import { pct } from "../analytics.ts";
import type { AutomationStep } from "../automations.ts";
import type { Campaign } from "../campaigns.ts";
import type { Newsletter } from "../newsletter.ts";
import { parseRulesText, rulesToText } from "../segments.ts";
import type { SponsorInput, SponsorSlot } from "../sponsors.ts";
import { type NewsletterConfig, SETTING_LABELS } from "../settings.ts";
import { PROVIDERS, type ProviderSettings, type ProviderType, SECRET_KEYS, SMTP_PRESETS } from "../transport/factory.ts";
import { formatInZone, zonedTimeToUtc } from "../util.ts";

type Block = Record<string, unknown>;
export interface AdminResponse {
	blocks: Block[];
	toast?: { type: "success" | "error" | "info"; message: string };
}
interface Interaction {
	type: "page_load" | "block_action" | "form_submit";
	page?: string;
	action_id?: string;
	value?: unknown;
	values?: Record<string, unknown>;
}

const header = (text: string): Block => ({ type: "header", text });
const section = (text: string, accessory?: Block): Block => ({ type: "section", text, ...(accessory && { accessory }) });
const context = (text: string): Block => ({ type: "context", text });
const divider: Block = { type: "divider" };
const button = (label: string, action_id: string, opts: { style?: "primary" | "danger" | "secondary"; value?: unknown; confirm?: { title: string; text: string; confirm: string } } = {}): Block => ({
	type: "button",
	label,
	action_id,
	...(opts.style && { style: opts.style }),
	...(opts.value !== undefined && { value: opts.value }),
	...(opts.confirm && { confirm: { ...opts.confirm, deny: "Cancel", ...(opts.style === "danger" && { style: "danger" }) } }),
});
const actions = (...elements: Block[]): Block => ({ type: "actions", elements });
const banner = (title: string, description?: string, variant: "default" | "alert" | "error" = "default"): Block => ({ type: "banner", title, ...(description && { description }), variant });
const text = (action_id: string, label: string, initial?: string | null, extra: Record<string, unknown> = {}): Block => ({
	type: "text_input",
	action_id,
	label,
	...(initial ? { initial_value: initial } : {}),
	...extra,
});
const select = (action_id: string, label: string, options: { label: string; value: string }[], initial?: string | null, extra: Record<string, unknown> = {}): Block => ({
	type: "select",
	action_id,
	label,
	options,
	...(initial ? { initial_value: initial } : {}),
	...extra,
});
const toggle = (action_id: string, label: string, initial: boolean, description?: string): Block => ({ type: "toggle", action_id, label, initial_value: initial, ...(description && { description }) });
const num = (action_id: string, label: string, initial: number, min?: number, max?: number): Block => ({ type: "number_input", action_id, label, initial_value: initial, ...(min !== undefined && { min }), ...(max !== undefined && { max }) });
const form = (block_id: string, fields: Block[], submit: string, action_id: string): Block => ({ type: "form", block_id, fields, submit: { label: submit, action_id } });
const nav = (label: string, page: string, style: "primary" | "secondary" = "secondary"): Block => ({ type: "link", label, target: { kind: "plugin-page", path: page }, appearance: style });

const str = (v: unknown) => (typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v));
const bool = (v: unknown) => v === true || v === "true" || v === "on" || v === 1;
const int = (v: unknown, d = 0) => (Number.isFinite(Number(v)) && str(v) !== "" ? Math.round(Number(v)) : d);
const n = (x: number) => x.toLocaleString("en-US");

function zonedParts(ms: number, timeZone: string): { date: string; time: string } {
	try {
		const p = Object.fromEntries(
			new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
				.formatToParts(new Date(ms))
				.map((x) => [x.type, x.value]),
		);
		return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
	} catch {
		const iso = new Date(ms).toISOString();
		return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
	}
}

const STATUS_LABEL: Record<string, string> = {
	draft: "Draft",
	scheduled: "Scheduled",
	testing: "A/B testing",
	sending: "Sending",
	sent: "Sent",
	canceled: "Canceled",
	failed: "Failed",
};

// ─────────────────────────────── pages ───────────────────────────────

async function problemsBanner(nl: Newsletter): Promise<Block[]> {
	const problems = await nl.settings.problems();
	if (!problems.length) return [];
	return [banner("Finish setup before sending", problems.join(" "), "alert"), actions(nav("Open email settings", "/settings", "primary"))];
}

async function overviewPage(nl: Newsletter): Promise<AdminResponse> {
	const [o, recent, config] = await Promise.all([nl.analytics.overview(), nl.campaigns.listCampaigns({ limit: 6 }), nl.settings.get()]);
	return {
		blocks: [
			header(config.publicationName),
			...(await problemsBanner(nl)),
			{
				type: "stats",
				items: [
					{ label: "Active subscribers", value: n(o.subscribers.active), description: `${n(o.subscribers.pending)} pending confirmation` },
					{ label: "New (30 days)", value: n(o.last30.newActive), trend: o.last30.newActive >= o.last30.unsubscribed ? "up" : "down", description: `${n(o.last30.unsubscribed)} unsubscribed` },
					{ label: "Open rate (30 days)", value: pct(o.last30.openRate), description: "Inflated by Apple Mail privacy" },
					{ label: "Click rate (30 days)", value: pct(o.last30.clickRate), description: `${n(o.last30.sent)} emails sent` },
				],
			},
			{ type: "chart", config: { chart_type: "timeseries", style: "bar", series: [{ name: "New subscribers", data: o.growth }], height: 220 } },
			...(o.queue.queued || o.queue.failed24h
				? [section(`Send queue: **${n(o.queue.queued)}** waiting, ${n(o.queue.sending)} sending, ${n(o.queue.failed24h)} failed in the last 24h.`, button("Process now", "queue:run"))]
				: []),
			header("Recent campaigns"),
			campaignTable(recent, config),
			actions(button("New campaign", "campaign:new", { style: "primary" }), nav("All campaigns", "/campaigns"), nav("Subscribers", "/subscribers")),
		],
	};
}

async function widget(nl: Newsletter): Promise<AdminResponse> {
	const o = await nl.analytics.overview();
	return {
		blocks: [
			{
				type: "stats",
				items: [
					{ label: "Subscribers", value: n(o.subscribers.active) },
					{ label: "New (30d)", value: n(o.last30.newActive) },
					{ label: "Click rate", value: pct(o.last30.clickRate) },
				],
			},
			actions(nav("Open newsletter", "/", "primary")),
		],
	};
}

function campaignTable(list: Campaign[], config: NewsletterConfig): Block {
	return {
		type: "table",
		page_action_id: "campaigns:page",
		empty_text: "No campaigns yet.",
		columns: [
			{ key: "name", label: "Campaign" },
			{ key: "status", label: "Status", format: "badge" },
			{ key: "when", label: "When" },
			{ key: "recipients", label: "Recipients", format: "number" },
			{ key: "open", label: "" , format: "element" },
		],
		rows: list.map((c) => ({
			name: c.name,
			status: STATUS_LABEL[c.status] ?? c.status,
			when: formatInZone(c.sentAt ?? c.scheduledAt ?? c.updatedAt, config.timezone),
			recipients: c.recipientsTotal,
			open: button(["draft", "scheduled"].includes(c.status) ? "Edit" : "Report", "campaign:open", { value: c.id }),
		})),
	};
}

async function campaignsPage(nl: Newsletter): Promise<AdminResponse> {
	const [list, config] = await Promise.all([nl.campaigns.listCampaigns({ limit: 100 }), nl.settings.get()]);
	return {
		blocks: [header("Campaigns"), ...(await problemsBanner(nl)), actions(button("New campaign", "campaign:new", { style: "primary" })), campaignTable(list, config)],
	};
}

async function audienceOptions(nl: Newsletter) {
	const [segments, topics] = await Promise.all([nl.segments.listSegments(), nl.subscribers.listTopics()]);
	return {
		segments: [{ label: "All active subscribers", value: "" }, ...segments.map((s) => ({ label: s.name, value: s.id }))],
		topics: [{ label: "Any topic", value: "" }, ...topics.map((t) => ({ label: t.name, value: t.slug }))],
	};
}

async function campaignEditor(nl: Newsletter, id: string, opts: { preview?: boolean } = {}): Promise<AdminResponse> {
	const c = await nl.campaigns.getCampaign(id);
	if (!c) return { ...(await campaignsPage(nl)), toast: { type: "error", message: "Campaign not found" } };
	if (!["draft", "scheduled"].includes(c.status)) return campaignReport(nl, c);
	const [config, aud] = await Promise.all([nl.settings.get(), audienceOptions(nl)]);
	const count = await nl.segments.countAudience({ segmentId: c.segmentId, topic: c.audience?.topic ?? null }).catch(() => 0);
	const blocks: Block[] = [
		header(c.status === "scheduled" ? `Scheduled: ${c.name}` : `Edit: ${c.name}`),
		...(await problemsBanner(nl)),
		...(c.status === "scheduled" ? [banner(`Sends ${formatInZone(c.scheduledAt, config.timezone)} (${config.timezone})`, "Edits are saved into the scheduled send.")] : []),
		form(
			"campaign",
			[
				text("subject", "Subject line", c.subject),
				text("preheader", "Preview text (shown after the subject in inboxes)", c.preheader),
				text("name", "Internal name", c.name),
				...(c.contentFormat === "portable_text"
					? []
					: [
							select("content_format", "Format", [
								{ label: "Markdown", value: "markdown" },
								{ label: "HTML", value: "html" },
							], c.contentFormat),
							text("content", "Content", c.content, {
								multiline: true,
								placeholder: "# Headline\n\nHi {{first_name|there}},\n\n[[Button label]](https://…)",
							}),
						]),
				select("segment_id", "Send to", aud.segments, c.segmentId ?? ""),
				select("topic", "Only readers subscribed to topic", aud.topics, c.audience?.topic ?? ""),
				toggle("ab", "A/B test the subject line", c.abTestPct > 0),
				text("subject_b", "Subject line B", c.subjectB, { condition: { field: "ab", eq: true } }),
				{ ...num("ab_pct", "Test group per variant (% of audience)", c.abTestPct || 10, 1, 50), condition: { field: "ab", eq: true } },
				{ ...num("ab_wait", "Wait before picking the winner (minutes)", c.abWaitMinutes, 15, 2880), condition: { field: "ab", eq: true } },
				{ ...select("ab_metric", "Winner is decided by", [{ label: "Clicks", value: "clicks" }, { label: "Opens", value: "opens" }], c.abMetric), condition: { field: "ab", eq: true } },
				toggle("publish_web", "Publish in the web archive", c.publishWeb),
				{ ...select("web_access", "Archive access", [{ label: "Everyone", value: "public" }, { label: "Members only", value: "members" }], c.webAccess), condition: { field: "publish_web", eq: true } },
				toggle("track_clicks", "Track clicks", c.trackClicks),
				toggle("track_opens", "Track opens", c.trackOpens),
			],
			"Save",
			`campaign:save:${c.id}`,
		),
		context(
			c.contentFormat === "portable_text"
				? "This issue was created from published content; its body is edited in the CMS entry."
				: "Merge tags: {{first_name|fallback}}, {{last_name}}, {{email}}, {{attr.your_field}}, {{referral_url}}, {{web_url}}. Buttons: [[Label]](https://url).",
		),
		section(`**Audience:** ${n(count)} active subscriber${count === 1 ? "" : "s"} right now.`),
		form("test", [text("emails", "Send a test to (comma-separated)", config.replyTo || config.from.email)], "Send test", `campaign:test:${c.id}`),
		form(
			"schedule",
			[
				{ type: "date_input", action_id: "date", label: `Date (${config.timezone})`, ...(c.scheduledAt ? { initial_value: zonedParts(c.scheduledAt, config.timezone).date } : {}) },
				text("time", "Time (24h, HH:MM)", c.scheduledAt ? zonedParts(c.scheduledAt, config.timezone).time : "06:00"),
			],
			c.status === "scheduled" ? "Reschedule" : "Schedule",
			`campaign:schedule:${c.id}`,
		),
		actions(
			button("Send now", `campaign:send:${c.id}`, { style: "primary", confirm: { title: "Send this campaign now?", text: `It goes to ${n(count)} subscribers and can't be unsent.`, confirm: "Send now" } }),
			...(c.status === "scheduled" ? [button("Unschedule", `campaign:unschedule:${c.id}`)] : []),
			button("Preview", `campaign:preview:${c.id}`),
			button("Duplicate", `campaign:duplicate:${c.id}`),
			button("Delete", `campaign:delete:${c.id}`, { style: "danger", confirm: { title: "Delete this draft?", text: "This can't be undone.", confirm: "Delete" } }),
			nav("Back to campaigns", "/campaigns"),
		),
	];
	if (opts.preview) {
		const sample = await nl.campaigns.renderCampaignFor(c.id, config.replyTo || config.from.email || "preview@example.com");
		blocks.push({ type: "accordion", label: `Preview: ${sample.subject}`, default_open: true, blocks: [context("Plain-text version. HTML styling is applied in the email; send a test to see it."), { type: "code", code: sample.text, language: "bash" }] });
	}
	return { blocks };
}

async function campaignReport(nl: Newsletter, c: Campaign): Promise<AdminResponse> {
	const [s, config] = await Promise.all([nl.analytics.campaignStats(c.id), nl.settings.get()]);
	const ab =
		c.subjectB && c.abTestPct > 0
			? [
					header("A/B test"),
					{
						type: "table",
						page_action_id: "noop",
						columns: [
							{ key: "variant", label: "Variant" },
							{ key: "subject", label: "Subject" },
							{ key: "sent", label: "Sent", format: "number" },
							{ key: "open", label: "Open rate" },
							{ key: "click", label: "Click rate" },
						],
						rows: (["a", "b"] as const).map((v) => ({
							variant: `${v.toUpperCase()}${c.abWinner === v ? " (winner)" : ""}`,
							subject: v === "a" ? c.subject : c.subjectB,
							sent: s.variants[v]?.sent ?? 0,
							open: pct(s.variants[v]?.sent ? s.variants[v].opens / s.variants[v].sent : 0),
							click: pct(s.variants[v]?.sent ? s.variants[v].clicks / s.variants[v].sent : 0),
						})),
					},
					...(c.status === "testing" ? [context(`The winner is picked ${formatInZone(c.abDecideAt, config.timezone)} by ${c.abMetric}, then sent to everyone else.`)] : []),
				]
			: [];
	return {
		blocks: [
			header(c.name),
			{
				type: "fields",
				fields: [
					{ label: "Status", value: STATUS_LABEL[c.status] ?? c.status },
					{ label: "Subject", value: c.subject },
					{ label: "Started", value: formatInZone(c.startedAt, config.timezone) || "—" },
					{ label: "Finished", value: formatInZone(c.sentAt, config.timezone) || "—" },
				],
			},
			...(c.error ? [banner("Send failed", c.error, "error")] : []),
			...(s.queued ? [{ type: "meter", label: "Sending", value: s.sent, max: Math.max(1, s.sent + s.queued), custom_value: `${n(s.sent)} / ${n(s.sent + s.queued)}` }] : []),
			{
				type: "stats",
				items: [
					{ label: "Sent", value: n(s.sent), description: s.failed ? `${n(s.failed)} failed` : undefined },
					{ label: "Open rate", value: pct(s.openRate), description: `${n(s.uniqueOpens)} unique` },
					{ label: "Click rate", value: pct(s.clickRate), description: `${n(s.uniqueClicks)} unique · CTOR ${pct(s.clickToOpen)}` },
					{ label: "Unsubscribed", value: n(s.unsubscribed), description: `${n(s.bounced)} bounced · ${n(s.complained)} complaints` },
				],
			},
			...(s.timeline.length > 1 ? [{ type: "chart", config: { chart_type: "timeseries", series: [{ name: "Opens per hour", data: s.timeline }], height: 220, gradient: true } }] : []),
			...ab,
			header("Links"),
			{
				type: "table",
				page_action_id: "noop",
				empty_text: "No clicks yet.",
				columns: [
					{ key: "url", label: "URL", format: "code" },
					{ key: "clicks", label: "Clicks", format: "number" },
					{ key: "unique", label: "Unique", format: "number" },
				],
				rows: s.links,
			},
			context("Open rates are approximate: Apple Mail Privacy Protection loads images automatically. Clicks are the reliable signal."),
			actions(
				...(["sending", "testing"].includes(c.status)
					? [button("Cancel sending", `campaign:cancel:${c.id}`, { style: "danger", confirm: { title: "Stop this send?", text: "Emails already sent can't be recalled.", confirm: "Stop sending" } })]
					: []),
				button("Refresh", `campaign:open:${c.id}`),
				button("Duplicate", `campaign:duplicate:${c.id}`),
				nav("Back to campaigns", "/campaigns"),
			),
		],
	};
}

async function subscribersPage(nl: Newsletter, f: { search?: string; status?: string; tag?: string; offset?: number } = {}, extra: Block[] = []): Promise<AdminResponse> {
	const offset = f.offset ?? 0;
	const [{ items, total }, o] = await Promise.all([
		nl.subscribers.listSubscribers({ search: f.search, status: (f.status || "") as never, tag: f.tag, limit: 50, offset }),
		nl.analytics.overview(),
	]);
	return {
		blocks: [
			header("Subscribers"),
			{
				type: "stats",
				items: [
					{ label: "Active", value: n(o.subscribers.active) },
					{ label: "Pending", value: n(o.subscribers.pending) },
					{ label: "Unsubscribed", value: n(o.subscribers.unsubscribed) },
					{ label: "Bounced / complained", value: n(o.subscribers.bounced + o.subscribers.complained) },
				],
			},
			...extra,
			form(
				"filter",
				[
					text("search", "Search email or name", f.search),
					select("status", "Status", [{ label: "Any", value: "" }, ...["active", "pending", "unsubscribed", "bounced", "complained"].map((s) => ({ label: s, value: s }))], f.status ?? ""),
					text("tag", "Tag", f.tag),
				],
				"Filter",
				"subs:search",
			),
			context(`${n(total)} matching · showing ${total ? offset + 1 : 0}–${Math.min(offset + 50, total)}`),
			{
				type: "table",
				page_action_id: "subs:page",
				empty_text: "No subscribers match.",
				columns: [
					{ key: "email", label: "Email" },
					{ key: "name", label: "Name" },
					{ key: "status", label: "Status", format: "badge" },
					{ key: "tags", label: "Tags" },
					{ key: "source", label: "Source" },
					{ key: "joined", label: "Joined", format: "relative_time" },
					{ key: "open", label: "", format: "element" },
				],
				rows: items.map((s) => ({
					email: s.email,
					name: [s.firstName, s.lastName].filter(Boolean).join(" "),
					status: s.status,
					tags: (s.tags ?? []).filter((t) => !t.startsWith("topic:")).join(", "),
					source: s.source ?? "",
					joined: new Date(s.createdAt).toISOString(),
					open: button("Open", "sub:open", { value: s.id }),
				})),
				...(offset + 50 < total ? { next_cursor: JSON.stringify({ ...f, offset: offset + 50 }) } : {}),
			},
			header("Add subscriber"),
			form(
				"add",
				[text("email", "Email"), text("first_name", "First name"), text("tags", "Tags (comma-separated)"), toggle("confirmed", "They already agreed to receive email (skip confirmation)", false)],
				"Add",
				"subs:add",
			),
			{
				type: "accordion",
				label: "Import from CSV",
				blocks: [
					context("Header row required. Columns: email, first_name, last_name, tags (semicolon-separated), source. Other columns become custom fields."),
					form(
						"import",
						[
							text("csv", "CSV", "", { multiline: true, placeholder: "email,first_name,tags\nada@example.com,Ada,vip" }),
							text("tags", "Add these tags to everyone (comma-separated)"),
							select("status", "Import as", [{ label: "Active (I have their consent)", value: "active" }, { label: "Pending (send each a confirmation email)", value: "pending" }], "active"),
						],
						"Import",
						"subs:import",
					),
				],
			},
			actions(button("Export CSV", "subs:export", { value: f.status ?? "" })),
		],
	};
}

async function subscriberDetail(nl: Newsletter, id: string): Promise<AdminResponse> {
	const s = await nl.subscribers.getSubscriber(id, true);
	if (!s) return { ...(await subscribersPage(nl)), toast: { type: "error", message: "Subscriber not found" } };
	const config = await nl.settings.get();
	return {
		blocks: [
			header(s.email),
			{
				type: "fields",
				fields: [
					{ label: "Status", value: s.status },
					{ label: "Name", value: [s.firstName, s.lastName].filter(Boolean).join(" ") || "—" },
					{ label: "Source", value: s.source ?? "—" },
					{ label: "Joined", value: formatInZone(s.createdAt, config.timezone) },
					{ label: "Confirmed", value: formatInZone(s.confirmedAt, config.timezone) || "—" },
					{ label: "Last open / click", value: `${formatInZone(s.lastOpenAt, config.timezone) || "—"} / ${formatInZone(s.lastClickAt, config.timezone) || "—"}` },
					{ label: "Referral code", value: s.referralCode },
					{ label: "Consent IP", value: s.consentIp ?? "—" },
				],
			},
			...(Object.keys(s.attributes).length ? [{ type: "code", code: JSON.stringify(s.attributes, null, 2), language: "jsonc" }] : []),
			form(
				"edit",
				[text("first_name", "First name", s.firstName), text("last_name", "Last name", s.lastName), text("tags", "Tags (comma-separated)", (s.tags ?? []).join(", "))],
				"Save",
				`sub:save:${s.id}`,
			),
			actions(
				s.status === "active"
					? button("Unsubscribe", `sub:unsub:${s.id}`, { confirm: { title: "Unsubscribe this person?", text: "They'll stop receiving all emails.", confirm: "Unsubscribe" } })
					: button("Mark active", `sub:resub:${s.id}`, { confirm: { title: "Resubscribe?", text: "Only do this if they asked to be resubscribed.", confirm: "Resubscribe" } }),
				button("Delete (GDPR)", `sub:delete:${s.id}`, { style: "danger", confirm: { title: "Erase this subscriber?", text: "Removes them and anonymises their history. This can't be undone.", confirm: "Erase" } }),
				nav("Back to subscribers", "/subscribers"),
			),
		],
	};
}

const RULE_HELP =
	"One condition per line: `field op value`. Fields: tag has|not_has <tag> · topic has|not_has <slug> · source eq|neq|starts_with <x> · email contains|ends_with <x> · attr.<key> eq|neq|contains|exists <x> · created_at|confirmed_at before|after <YYYY-MM-DD> or within_days <n> · opened|clicked within_days|not_within_days <n> · referrals gte <n>";

async function audiencePage(nl: Newsletter, editId?: string): Promise<AdminResponse> {
	const [segments, topics] = await Promise.all([nl.segments.listSegments(), nl.subscribers.listTopics()]);
	const counts = await Promise.all(segments.map((s) => nl.segments.countAudience({ segmentId: s.id }).catch(() => 0)));
	const editing = editId ? segments.find((s) => s.id === editId) : undefined;
	return {
		blocks: [
			header("Segments"),
			{
				type: "table",
				page_action_id: "noop",
				empty_text: "No segments yet. Campaigns go to all active subscribers by default.",
				columns: [
					{ key: "name", label: "Segment" },
					{ key: "count", label: "Active members", format: "number" },
					{ key: "edit", label: "", format: "element" },
				],
				rows: segments.map((s, i) => ({ name: s.name, count: counts[i], edit: button("Edit", "seg:open", { value: s.id }) })),
			},
			header(editing ? `Edit segment: ${editing.name}` : "New segment"),
			form(
				"segment",
				[
					text("name", "Name", editing?.name),
					select("match", "Match", [{ label: "All conditions", value: "all" }, { label: "Any condition", value: "any" }], editing?.rules.match ?? "all"),
					text("rules", "Conditions", editing ? rulesToText(editing.rules) : "", { multiline: true, placeholder: "tag has vip\nclicked within_days 30" }),
				],
				editing ? "Save segment" : "Create segment",
				`seg:save:${editing?.id ?? "new"}`,
			),
			context(RULE_HELP),
			...(editing ? [actions(button("Delete segment", `seg:delete:${editing.id}`, { style: "danger", confirm: { title: "Delete this segment?", text: "Campaigns using it will go to all subscribers.", confirm: "Delete" } }), button("New segment", "nav:/audience"))] : []),
			divider,
			header("Topics"),
			context("Topics are lists readers choose in the preference center. Target a campaign at one topic from the editor."),
			{
				type: "table",
				page_action_id: "noop",
				empty_text: "No topics. Everyone gets every campaign.",
				columns: [
					{ key: "name", label: "Topic" },
					{ key: "slug", label: "Slug", format: "code" },
					{ key: "flags", label: "" },
					{ key: "del", label: "", format: "element" },
				],
				rows: topics.map((t) => ({
					name: t.name,
					slug: t.slug,
					flags: [t.isPublic ? "public" : "hidden", t.isDefault ? "default on" : "opt-in"].join(" · "),
					del: button("Delete", "topic:delete", { value: t.slug, style: "danger", confirm: { title: `Delete topic ${t.name}?`, text: "Readers lose this preference.", confirm: "Delete" } }),
				})),
			},
			form(
				"topic",
				[
					text("slug", "Slug (e.g. weekly)"),
					text("name", "Name"),
					text("description", "Description"),
					toggle("public", "Show in the preference center", true),
					toggle("default", "New subscribers get it automatically", true),
				],
				"Add or update topic",
				"topic:save",
			),
		],
	};
}

async function automationsPage(nl: Newsletter): Promise<AdminResponse> {
	const list = await nl.automations.listAutomations();
	const stats = await Promise.all(list.map((a) => nl.automations.automationStats(a.id)));
	return {
		blocks: [
			header("Automations"),
			context("Sequences that send on their own: a welcome series when someone confirms, or a course when a tag is added."),
			actions(button("New automation", "auto:new", { style: "primary" })),
			{
				type: "table",
				page_action_id: "noop",
				empty_text: "No automations yet.",
				columns: [
					{ key: "name", label: "Automation" },
					{ key: "trigger", label: "Trigger" },
					{ key: "status", label: "Status", format: "badge" },
					{ key: "steps", label: "Emails", format: "number" },
					{ key: "active", label: "In progress", format: "number" },
					{ key: "sent", label: "Sent", format: "number" },
					{ key: "edit", label: "", format: "element" },
				],
				rows: list.map((a, i) => ({
					name: a.name,
					trigger: a.trigger === "tag_added" ? `Tag added: ${a.triggerValue}` : a.trigger === "subscribed" ? "Subscribed" : "Manual",
					status: a.status,
					steps: a.steps.length,
					active: stats[i].active,
					sent: stats[i].sent,
					edit: button("Edit", "auto:open", { value: a.id }),
				})),
			},
		],
	};
}

async function automationEditor(nl: Newsletter, id: string): Promise<AdminResponse> {
	const a = await nl.automations.getAutomation(id);
	if (!a) return automationsPage(nl);
	const steps: AutomationStep[] = [...a.steps, { delayHours: a.steps.length ? 24 : 0, subject: "", content: "" }];
	const fields: Block[] = [
		text("name", "Name", a.name),
		select("trigger", "Trigger", [{ label: "When someone subscribes (confirmed)", value: "subscribed" }, { label: "When a tag is added", value: "tag_added" }, { label: "Manual enrollment only", value: "manual" }], a.trigger),
		text("trigger_value", "Tag", a.triggerValue, { condition: { field: "trigger", eq: "tag_added" } }),
		text("exit_tag", "Exit tag (optional): subscribers with this tag leave the sequence", a.exitTag, { placeholder: "e.g. customer" }),
		toggle("active", "Active", a.status === "active", "Paused automations hold everyone where they are."),
	];
	steps.forEach((s, i) => {
		fields.push(
			num(`delay_${i}`, `Email ${i + 1}: wait (hours) ${i === 0 ? "after enrollment" : "after the previous email"}`, s.delayHours, 0, 8760),
			text(`subject_${i}`, `Email ${i + 1}: subject${i === steps.length - 1 ? " (fill in to add a step)" : ""}`, s.subject),
			text(`content_${i}`, `Email ${i + 1}: content (Markdown)`, s.content, { multiline: true }),
		);
	});
	return {
		blocks: [
			header(`Automation: ${a.name}`),
			form("automation", fields, "Save automation", `auto:save:${a.id}`),
			context("Clear an email's subject to remove that step. Merge tags work as in campaigns."),
			actions(button("Delete automation", `auto:delete:${a.id}`, { style: "danger", confirm: { title: "Delete this automation?", text: "Queued emails from it are canceled.", confirm: "Delete" } }), nav("Back to automations", "/automations")),
		],
	};
}

// ─────────────────────────────── sponsors ───────────────────────────────

const money = (cents: number | null) => (cents === null ? "" : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0 })}`);

function sponsorFields(s: Partial<SponsorSlot> & { date: string }): Block[] {
	return [
		text("date", "Date (YYYY-MM-DD, publication time zone)", s.date, { placeholder: "2026-12-01" }),
		select("status", "Status", [{ label: "Booked (shows in the email)", value: "booked" }, { label: "Hold (reserves the date, not shown)", value: "hold" }], s.status ?? "booked"),
		text("sponsor", "Sponsor name", s.sponsor),
		text("headline", "Headline", s.headline),
		text("body", "Copy (1–3 sentences, plain text)", s.body, { multiline: true }),
		text("url", "Link (https://…, UTM tags welcome)", s.url),
		text("cta", "Link label", s.ctaLabel, { placeholder: "Learn more" }),
		text("image", "Image URL (optional, https)", s.imageUrl),
		text("contact", "Sponsor contact email (internal)", s.contactEmail),
		text("price", "Price in dollars (internal)", s.priceCents === null || s.priceCents === undefined ? "" : String(s.priceCents / 100)),
		text("notes", "Notes (internal)", s.notes, { multiline: true }),
	];
}

function sponsorInput(v: Record<string, unknown>): SponsorInput {
	const price = str(v.price).replace(/[$,\s]/g, "");
	return {
		date: str(v.date),
		status: str(v.status) === "hold" ? "hold" : "booked",
		sponsor: str(v.sponsor),
		headline: str(v.headline),
		body: str(v.body),
		url: str(v.url),
		ctaLabel: str(v.cta) || null,
		imageUrl: str(v.image) || null,
		contactEmail: str(v.contact) || null,
		priceCents: price && Number.isFinite(Number(price)) ? Math.round(Number(price) * 100) : null,
		notes: str(v.notes) || null,
	};
}

async function sponsorsPage(nl: Newsletter, draft?: SponsorInput): Promise<AdminResponse> {
	const config = await nl.settings.get();
	const today = zonedParts(Date.now(), config.timezone || "UTC").date;
	const days = await nl.sponsors.sponsorCalendar(today, 60);
	const free = days.filter((d) => !d.slot).map((d) => d.date);
	const upcoming = days.flatMap((d) => (d.slot ? [d.slot] : []));
	const past = (await nl.sponsors.listSponsorSlots({ to: today })).filter((s) => s.date < today).reverse().slice(0, 30);
	const clicks = await Promise.all(past.map((s) => nl.sponsors.sponsorClicks(s)));
	const row = (s: SponsorSlot, c?: { clicks: number; unique: number } | null) => ({
		date: s.date,
		status: s.status,
		sponsor: s.sponsor,
		headline: s.headline,
		price: money(s.priceCents),
		clicks: c ? `${n(c.unique)} unique / ${n(c.clicks)}` : "",
		edit: button("Edit", "sponsor:open", { value: s.id }),
	});
	const columns = [
		{ key: "date", label: "Date" },
		{ key: "status", label: "Status", format: "badge" },
		{ key: "sponsor", label: "Sponsor" },
		{ key: "headline", label: "Headline" },
		{ key: "price", label: "Price" },
	];
	const scope = config.sponsors.autoIssuesOnly ? ", in auto-sent issues only" : "";
	const hidden = config.sponsors.hideForTags.length ? ` Hidden for subscribers tagged ${config.sponsors.hideForTags.join(", ")}.` : "";
	return {
		blocks: [
			header("Sponsors"),
			...(config.sponsors.enabled ? [] : [banner("Sponsor ads are off", "Bookings are saved but not shown. Turn them on in Email settings → Sponsors.", "alert")]),
			context(`One ad per date, shown in the issue sent that day (${config.timezone || "UTC"})${scope}.${hidden}`),
			section(`**Open dates, next 60 days (${free.length}):** ${free.slice(0, 20).join(", ")}${free.length > 20 ? "…" : ""}`),
			{ type: "table", page_action_id: "noop", empty_text: "Nothing booked in the next 60 days.", columns: [...columns, { key: "edit", label: "", format: "element" }], rows: upcoming.map((s) => row(s)) },
			divider,
			header("Book a date"),
			form("sponsor_new", sponsorFields({ ...draft, date: draft?.date || free[0] || today } as Partial<SponsorSlot> & { date: string }), "Book", "sponsor:book"),
			...(past.length
				? [
						divider,
						header("Past sponsors"),
						{
							type: "table",
							page_action_id: "noop",
							columns: [...columns, { key: "clicks", label: "Clicks" }, { key: "edit", label: "", format: "element" }],
							rows: past.map((s, i) => row(s, clicks[i])),
						},
					]
				: []),
		],
	};
}

async function sponsorEditor(nl: Newsletter, id: string): Promise<AdminResponse> {
	const s = await nl.sponsors.getSponsorSlot(id);
	if (!s) return sponsorsPage(nl);
	const c = await nl.sponsors.sponsorClicks(s);
	return {
		blocks: [
			header(`Sponsor: ${s.sponsor} on ${s.date}`),
			...(s.status === "canceled" ? [banner("Canceled", "This booking no longer reserves its date.", "alert")] : []),
			...(c ? [context(`Ran in campaign ${s.campaignId}: ${n(c.unique)} unique clicks (${n(c.clicks)} total).`)] : []),
			form("sponsor_edit", sponsorFields(s), "Save", `sponsor:save:${s.id}`),
			actions(
				...(s.status !== "canceled"
					? [button("Cancel booking", `sponsor:cancel:${s.id}`, { confirm: { title: "Cancel this booking?", text: "The date becomes available again.", confirm: "Cancel booking" } })]
					: []),
				button("Delete", `sponsor:delete:${s.id}`, { style: "danger", confirm: { title: "Delete this booking?", text: "It is removed for good, including from reports.", confirm: "Delete" } }),
				nav("Back to sponsors", "/sponsors"),
			),
		],
	};
}

function providerFields(c: NewsletterConfig): Block[] {
	const fields: Block[] = [select("provider_type", "Email provider", PROVIDERS.map((p) => ({ label: p.label, value: p.type })), c.provider?.type ?? "bird")];
	for (const p of PROVIDERS) {
		for (const f of p.fields) {
			const id = `p_${p.type}_${f.key}`;
			const cond = { condition: { field: "provider_type", eq: p.type } };
			const current = c.provider?.type === p.type ? (c.provider as unknown as Record<string, unknown>)[f.key] : undefined;
			if (f.kind === "secret") fields.push({ type: "secret_input", action_id: id, label: f.label, has_value: !!current, placeholder: current ? "Saved. Leave blank to keep." : "", ...cond });
			else if (f.kind === "select") fields.push(select(id, f.label, f.options ?? [], (current as string) ?? f.options?.[0]?.value, cond));
			else if (f.kind === "number") fields.push({ ...num(id, f.label, Number(current ?? 465)), ...cond });
			else fields.push(text(id, f.label, (current as string) ?? "", cond));
		}
	}
	return fields;
}

async function settingsPage(nl: Newsletter): Promise<AdminResponse> {
	const c = await nl.settings.stored();
	const live = await nl.settings.get();
	const provider = PROVIDERS.find((p) => p.type === live.provider?.type);
	const webhookUrl = provider ? await nl.webhookUrl(provider.webhook.replace("/webhooks/", "")) : await nl.webhookUrl("generic");
	return {
		blocks: [
			header("Email settings"),
			...(await problemsBanner(nl)),
			...(nl.settings.overridden().length
				? [
						banner(
							"Some settings are set in code",
							`${nl.settings
								.overridden()
								.map((k) => SETTING_LABELS[k] ?? k)
								.join(", ")} ${nl.settings.overridden().length === 1 ? "is" : "are"} configured in the site's code, so changes to ${nl.settings.overridden().length === 1 ? "it" : "them"} here won't take effect.`,
						),
					]
				: []),
			{
				type: "tab",
				panels: [
					{
						label: "Provider",
						blocks: [
							context("The newsletter keeps the list; the provider only delivers. Use any provider's API or any SMTP server."),
							form("provider", providerFields(c), "Save provider", "settings:provider"),
							actions(button("Check credentials", "settings:verify")),
							form("ptest", [text("to", "Send a provider test to", live.replyTo || live.from.email)], "Send test email", "settings:test"),
							header("Delivery events webhook"),
							context(
								`Point your provider's event webhook (bounces, complaints, unsubscribes) at this URL. ${provider?.type === "bird" ? "In Bird: Developers → Webhooks, events email.bounced, email.out_of_band_bounce, email.complained, email.unsubscribed, email.list_unsubscribed, email.rejected, email.delivered." : ""}`,
							),
							{ type: "code", code: webhookUrl, language: "bash" },
							form(
								"webhooks",
								[
									{ type: "secret_input", action_id: "bird", label: "Bird signing secret (whsec_…)", has_value: !!c.webhookSecrets.bird },
									{ type: "secret_input", action_id: "resend", label: "Resend signing secret (whsec_…)", has_value: !!c.webhookSecrets.resend },
									{ type: "secret_input", action_id: "mailgun", label: "Mailgun webhook signing key", has_value: !!c.webhookSecrets.mailgun },
								],
								"Save signing secrets",
								"settings:webhooks",
							),
						],
					},
					{
						label: "Publication",
						blocks: [
							form(
								"general",
								[
									text("publicationName", "Publication name", c.publicationName),
									text("siteUrl", "Site URL", c.siteUrl, { placeholder: "https://example.com" }),
									text("publicBasePath", "Public path (where the site mounts the newsletter handler)", c.publicBasePath),
									text("fromEmail", "From email (on your verified sending domain)", c.from.email),
									text("fromName", "From name", c.from.name),
									text("replyTo", "Reply-to email", c.replyTo),
									text("postalAddress", "Postal address (required in the footer by CAN-SPAM)", c.postalAddress),
									text("timezone", "Time zone (IANA, e.g. America/New_York)", c.timezone),
									text("accentColor", "Accent color", c.brand.accentColor),
									text("logoUrl", "Logo URL (optional)", c.brand.logoUrl),
									text("footerText", "Footer note (optional)", c.brand.footerText),
									toggle("doubleOptIn", "Double opt-in (confirm by email)", c.doubleOptIn, "Strongly recommended: protects deliverability."),
									toggle("trackOpens", "Track opens", c.trackOpens),
									toggle("trackClicks", "Track clicks", c.trackClicks),
									num("sendRatePerMinute", "Max emails per minute", c.sendRatePerMinute, 1, 100000),
									{ type: "secret_input", action_id: "turnstileSecret", label: "Cloudflare Turnstile secret (optional)", has_value: !!c.turnstileSecret },
								],
								"Save",
								"settings:general",
							),
						],
					},
					{
						label: "Sign-up emails",
						blocks: [
							form(
								"emails",
								[
									text("confirmSubject", "Confirmation subject", c.confirmation.subject),
									text("confirmIntro", "Confirmation message", c.confirmation.intro, { multiline: true }),
									toggle("welcomeEnabled", "Send a welcome email after confirming", c.welcome.enabled),
									text("welcomeSubject", "Welcome subject", c.welcome.subject, { condition: { field: "welcomeEnabled", eq: true } }),
									text("welcomeContent", "Welcome message (Markdown)", c.welcome.content, { multiline: true, condition: { field: "welcomeEnabled", eq: true } }),
								],
								"Save",
								"settings:emails",
							),
							context("For a multi-email welcome series, use Automations with the “subscribed” trigger instead."),
						],
					},
					{
						label: "Publish → email",
						blocks: [
							context("Turn published CMS entries into newsletter issues automatically."),
							form(
								"autosend",
								[
									select("mode", "When an entry is published", [{ label: "Do nothing", value: "off" }, { label: "Create a draft campaign", value: "draft" }, { label: "Send it to subscribers", value: "send" }], c.autoSend.mode),
									text("collection", "Collection slug", c.autoSend.collection, { placeholder: "posts" }),
									text("titleField", "Title field", c.autoSend.titleField),
									text("excerptField", "Excerpt field", c.autoSend.excerptField),
									text("bodyField", "Body field (Portable Text; blank = excerpt only)", c.autoSend.bodyField),
									text("extraFields", "Extra fields to include (comma-separated)", c.autoSend.extraFields.join(", ")),
									text("urlPattern", "Public URL pattern", c.autoSend.urlPattern),
									text("sendAtField", "Send-at date field (blank = send on publish)", c.autoSend.sendAtField ?? "", { placeholder: "issue_date" }),
									text("subjectTemplate", "Subject ({title} is replaced)", c.autoSend.subjectTemplate),
									text("readMoreLabel", "“Read more” button label (blank hides it)", c.autoSend.readMoreLabel),
									select("audience", "Send to", (await audienceOptions(nl)).segments, c.autoSend.audience === "all" ? "" : c.autoSend.audience),
									toggle("publishWeb", "Publish in the web archive", c.autoSend.publishWeb),
									select("webAccess", "Archive access", [{ label: "Everyone", value: "public" }, { label: "Members only", value: "members" }], c.autoSend.webAccess),
								],
								"Save",
								"settings:autosend",
							),
						],
					},
					{
						label: "Referrals",
						blocks: [
							context("Every subscriber gets a referral link in each issue. Confirmed referrals unlock rewards; each milestone adds a tag (e.g. referral:3) you can use in automations or fulfil from code."),
							form(
								"referrals",
								[
									toggle("enabled", "Referral program on", c.referrals.enabled),
									text("milestones", "Milestones, one per line: count | reward | tag (optional)", c.referrals.milestones.map((m) => [m.count, m.reward, m.tag ?? ""].join(" | ").replace(/ \| $/, "")).join("\n"), { multiline: true, placeholder: "3 | 1 month of Pro\n10 | Sticker pack | swag" }),
								],
								"Save",
								"settings:referrals",
							),
						],
					},
					{
						label: "Sponsors",
						blocks: [
							context("Book sponsors by date under Newsletter → Sponsors. The booked ad appears after the body of the issue sent that day."),
							form(
								"sponsors",
								[
									toggle("enabled", "Show sponsor ads", c.sponsors.enabled),
									text("label", "Label above the ad", c.sponsors.label, { placeholder: "Sponsored by" }),
									text("hide", "Hide the ad for subscribers with these tags (comma-separated)", c.sponsors.hideForTags.join(", "), { placeholder: "plan:pro" }),
									toggle("autoOnly", "Only in auto-sent issues", c.sponsors.autoIssuesOnly, "Off: every campaign sent that day carries the ad."),
								],
								"Save",
								"settings:sponsors",
							),
						],
					},
				],
			},
		],
	};
}

// ─────────────────────────────── actions ───────────────────────────────

function campaignPatch(v: Record<string, unknown>) {
	const ab = bool(v.ab);
	return {
		subject: str(v.subject) || "Untitled issue",
		preheader: str(v.preheader) || null,
		name: str(v.name) || undefined,
		...(v.content !== undefined && { content: str(v.content), contentFormat: (str(v.content_format) === "html" ? "html" : "markdown") as "html" | "markdown" }),
		segmentId: str(v.segment_id) || null,
		audience: { topic: str(v.topic) || null },
		subjectB: ab ? str(v.subject_b) || null : null,
		abTestPct: ab ? int(v.ab_pct, 10) : 0,
		abWaitMinutes: int(v.ab_wait, 240),
		abMetric: (str(v.ab_metric) === "opens" ? "opens" : "clicks") as "opens" | "clicks",
		publishWeb: bool(v.publish_web),
		webAccess: (str(v.web_access) === "members" ? "members" : "public") as "members" | "public",
		trackClicks: bool(v.track_clicks),
		trackOpens: bool(v.track_opens),
	};
}

const tagList = (v: unknown) => str(v).split(",").map((t) => t.trim()).filter(Boolean);

async function act(nl: Newsletter, i: Interaction, role: number): Promise<AdminResponse> {
	const [area, verb, ...rest] = (i.action_id ?? "").split(":");
	const id = rest.join(":") || (typeof i.value === "string" ? i.value : "");
	const v = i.values ?? {};
	const ok = (r: AdminResponse, message: string): AdminResponse => ({ ...r, toast: { type: "success", message } });
	const fail = (r: AdminResponse, message: string): AdminResponse => ({ ...r, toast: { type: "error", message } });

	if (area === "nav") return renderPage(nl, verb === "" ? "/" : `${verb}${rest.length ? `:${rest.join(":")}` : ""}`);
	if (area === "queue" && verb === "run") {
		const r = await nl.tick({ budgetMs: 20_000 });
		return ok(await overviewPage(nl), `Sent ${r.outbox.sent}, retrying ${r.outbox.retried}, failed ${r.outbox.failed}${r.outbox.error ? ` (${r.outbox.error})` : ""}`);
	}

	if (area === "campaign" || area === "campaigns") {
		switch (verb) {
			case "page":
				return campaignsPage(nl);
			case "new": {
				const c = await nl.campaigns.createCampaign({
					subject: "Untitled issue",
					content: "# Your headline\n\nHi {{first_name|there}},\n\nWrite something worth opening.\n\n[[Read more]](https://example.com)",
				});
				return campaignEditor(nl, c.id);
			}
			case "open":
				return campaignEditor(nl, id);
			case "preview":
				return campaignEditor(nl, id, { preview: true });
			case "save":
				await nl.campaigns.updateCampaign(id, campaignPatch(v));
				return ok(await campaignEditor(nl, id), "Saved");
			case "test": {
				const r = await nl.campaigns.sendTest(id, str(v.emails).split(/[,\s]+/));
				return r.errors.length ? fail(await campaignEditor(nl, id), r.errors.join("; ")) : ok(await campaignEditor(nl, id), `Test sent to ${r.sent.join(", ")}`);
			}
			case "schedule": {
				const config = await nl.settings.get();
				const at = zonedTimeToUtc(str(v.date), str(v.time) || "06:00", config.timezone);
				if (!Number.isFinite(at) || at < Date.now() + 60_000) return fail(await campaignEditor(nl, id), "Pick a date and time at least a minute from now.");
				await nl.campaigns.scheduleCampaign(id, at);
				return ok(await campaignEditor(nl, id), `Scheduled for ${formatInZone(at, config.timezone)}`);
			}
			case "unschedule":
				await nl.campaigns.unscheduleCampaign(id);
				return ok(await campaignEditor(nl, id), "Back to draft");
			case "send": {
				const c = await nl.campaigns.startCampaign(id);
				await nl.tick({ budgetMs: 10_000 }).catch(() => null);
				return ok(await campaignReport(nl, (await nl.campaigns.getCampaign(id)) ?? c), c.status === "testing" ? "A/B test started" : "Sending started");
			}
			case "cancel":
				await nl.campaigns.cancelCampaign(id);
				return ok(await campaignEditor(nl, id), "Sending stopped");
			case "duplicate": {
				const copy = await nl.campaigns.duplicateCampaign(id);
				return ok(await campaignEditor(nl, copy.id), "Duplicated");
			}
			case "delete":
				await nl.campaigns.deleteCampaign(id);
				return ok(await campaignsPage(nl), "Deleted");
		}
	}

	if (area === "subs") {
		switch (verb) {
			case "search":
				return subscribersPage(nl, { search: str(v.search), status: str(v.status), tag: str(v.tag) });
			case "page": {
				const raw = (i.value as { cursor?: string } | string | undefined) ?? "";
				const cursor = typeof raw === "string" ? raw : (raw.cursor ?? "");
				let f = {};
				try {
					f = cursor ? JSON.parse(cursor) : {};
				} catch {}
				return subscribersPage(nl, f);
			}
			case "add": {
				const r = await nl.subscribers.subscribe({ email: str(v.email), firstName: str(v.first_name) || undefined, tags: tagList(v.tags), source: "admin", confirmed: bool(v.confirmed) });
				if (r.status === "invalid_email") return fail(await subscribersPage(nl), "That email address isn't valid");
				return ok(await subscribersPage(nl), r.status === "pending" ? "Added. A confirmation email is on its way." : r.status === "already_active" ? "Already subscribed" : "Added");
			}
			case "import": {
				const r = await nl.subscribers.importCsv(str(v.csv), { tags: tagList(v.tags), status: str(v.status) === "pending" ? "pending" : "active" });
				return ok(await subscribersPage(nl), `Imported: ${r.added} added, ${r.updated} updated, ${r.invalid} invalid`);
			}
			case "export": {
				const csv = await nl.subscribers.exportCsv({ status: (typeof i.value === "string" ? i.value : "") as never, limit: 5000 });
				return subscribersPage(nl, {}, [{ type: "accordion", label: "CSV export (first 5,000 rows; copy it)", default_open: true, blocks: [{ type: "code", code: csv, language: "bash" }] }]);
			}
		}
	}

	if (area === "sub") {
		switch (verb) {
			case "open":
				return subscriberDetail(nl, id);
			case "save": {
				const s = await nl.subscribers.updateSubscriber(id, { firstName: str(v.first_name) || null, lastName: str(v.last_name) || null });
				if (s) {
					const want = new Set(tagList(v.tags));
					const have = new Set(s.tags ?? []);
					await nl.subscribers.removeTags(id, [...have].filter((t) => !want.has(t)));
					await nl.subscribers.addTags(id, [...want].filter((t) => !have.has(t)));
				}
				return ok(await subscriberDetail(nl, id), "Saved");
			}
			case "unsub":
				await nl.subscribers.unsubscribe(id, "admin");
				return ok(await subscriberDetail(nl, id), "Unsubscribed");
			case "resub":
				await nl.subscribers.activate(id);
				return ok(await subscriberDetail(nl, id), "Active again");
			case "delete":
				await nl.subscribers.deleteSubscriber(id);
				return ok(await subscribersPage(nl), "Subscriber erased");
		}
	}

	if (area === "seg") {
		switch (verb) {
			case "open":
				return audiencePage(nl, id);
			case "save": {
				const rules = parseRulesText(str(v.rules), str(v.match) === "any" ? "any" : "all");
				const name = str(v.name) || "Untitled segment";
				const seg = id === "new" ? await nl.segments.createSegment({ name, rules }) : await nl.segments.updateSegment(id, { name, rules });
				const count = seg ? await nl.segments.countAudience({ segmentId: seg.id }) : 0;
				return ok(await audiencePage(nl, seg?.id), `Saved. ${n(count)} active subscribers match.`);
			}
			case "delete":
				await nl.segments.deleteSegment(id);
				return ok(await audiencePage(nl), "Segment deleted");
		}
	}

	if (area === "topic") {
		if (verb === "save") {
			await nl.subscribers.saveTopic({ slug: str(v.slug) || str(v.name), name: str(v.name) || str(v.slug), description: str(v.description) || undefined, isPublic: bool(v.public), isDefault: bool(v.default) });
			return ok(await audiencePage(nl), "Topic saved");
		}
		if (verb === "delete") {
			await nl.subscribers.deleteTopic(id);
			return ok(await audiencePage(nl), "Topic deleted");
		}
	}

	if (area === "auto") {
		switch (verb) {
			case "new": {
				const a = await nl.automations.saveAutomation({
					name: "Welcome series",
					trigger: "subscribed",
					status: "paused",
					steps: [{ delayHours: 0, subject: "Welcome to {{publication}}", content: "Hi {{first_name|there}},\n\nThanks for subscribing! Here's what to expect…" }],
				});
				return automationEditor(nl, a.id);
			}
			case "open":
				return automationEditor(nl, id);
			case "save": {
				const steps: AutomationStep[] = [];
				for (let k = 0; k < 50; k++) {
					if (!(`subject_${k}` in v)) break;
					const subject = str(v[`subject_${k}`]);
					if (!subject) continue;
					steps.push({ delayHours: int(v[`delay_${k}`]), subject, content: str(v[`content_${k}`]) });
				}
				const trigger = (["subscribed", "tag_added", "manual"].includes(str(v.trigger)) ? str(v.trigger) : "manual") as "subscribed" | "tag_added" | "manual";
				await nl.automations.saveAutomation({ id, name: str(v.name) || "Automation", trigger, triggerValue: str(v.trigger_value) || null, exitTag: str(v.exit_tag) || null, status: bool(v.active) ? "active" : "paused", steps });
				return ok(await automationEditor(nl, id), "Saved");
			}
			case "delete":
				await nl.automations.deleteAutomation(id);
				return ok(await automationsPage(nl), "Automation deleted");
		}
	}

	if (area === "sponsor") {
		switch (verb) {
			case "open":
				return sponsorEditor(nl, id);
			case "book": {
				const input = sponsorInput(v);
				const r = await nl.sponsors.bookSponsorSlot(input);
				return r.ok ? ok(await sponsorsPage(nl), `Booked ${r.slot.sponsor} for ${r.slot.date}`) : fail(await sponsorsPage(nl, input), r.detail);
			}
			case "save": {
				const r = await nl.sponsors.updateSponsorSlot(id, sponsorInput(v));
				return r.ok ? ok(await sponsorEditor(nl, id), "Saved") : fail(await sponsorEditor(nl, id), r.detail);
			}
			case "cancel":
				await nl.sponsors.cancelSponsorSlot(id);
				return ok(await sponsorEditor(nl, id), "Booking canceled");
			case "delete":
				await nl.sponsors.deleteSponsorSlot(id);
				return ok(await sponsorsPage(nl), "Booking deleted");
		}
	}

	if (area === "settings") {
		if (role < 50 && verb !== "verify") return fail(await settingsPage(nl), "Only administrators can change email settings");
		const c = await nl.settings.stored();
		switch (verb) {
			case "provider": {
				const type = str(v.provider_type) as ProviderType;
				const info = PROVIDERS.find((p) => p.type === type);
				if (!info) return fail(await settingsPage(nl), "Choose a provider");
				const provider: Record<string, unknown> = { type };
				for (const f of info.fields) {
					const raw = v[`p_${type}_${f.key}`];
					provider[f.key] = f.kind === "number" ? int(raw) || undefined : str(raw) || undefined;
				}
				if (type === "smtp") {
					const preset = SMTP_PRESETS[str(provider.smtpPreset)];
					if (preset && str(provider.smtpPreset) !== "custom") {
						provider.host ||= preset.host;
						provider.port ||= preset.port;
						provider.security ||= preset.security;
						provider.username ||= preset.username;
					}
				}
				for (const k of SECRET_KEYS) if (provider[k] === undefined) delete provider[k];
				await nl.settings.update({ provider: provider as unknown as ProviderSettings });
				const check = await nl.verifyProvider();
				return check.ok ? ok(await settingsPage(nl), `Saved. ${check.detail}`) : fail(await settingsPage(nl), `Saved, but the check failed: ${check.detail}`);
			}
			case "verify": {
				const r = await nl.verifyProvider();
				return r.ok ? ok(await settingsPage(nl), r.detail) : fail(await settingsPage(nl), r.detail);
			}
			case "test": {
				const r = await nl.sendProviderTest(str(v.to));
				return r.ok ? ok(await settingsPage(nl), r.detail) : fail(await settingsPage(nl), r.detail);
			}
			case "webhooks":
				await nl.settings.update({ webhookSecrets: { bird: str(v.bird), resend: str(v.resend), mailgun: str(v.mailgun) } });
				return ok(await settingsPage(nl), "Saved");
			case "general":
				await nl.settings.update({
					publicationName: str(v.publicationName) || c.publicationName,
					siteUrl: str(v.siteUrl).replace(/\/$/, ""),
					publicBasePath: `/${str(v.publicBasePath).replace(/^\/+|\/+$/g, "") || "newsletter"}`,
					from: { email: str(v.fromEmail).toLowerCase(), name: str(v.fromName) },
					replyTo: str(v.replyTo).toLowerCase(),
					postalAddress: str(v.postalAddress),
					timezone: str(v.timezone) || "UTC",
					brand: { accentColor: str(v.accentColor) || "#4f3cc9", logoUrl: str(v.logoUrl), footerText: str(v.footerText) },
					doubleOptIn: bool(v.doubleOptIn),
					trackOpens: bool(v.trackOpens),
					trackClicks: bool(v.trackClicks),
					sendRatePerMinute: Math.max(1, int(v.sendRatePerMinute, 600)),
					turnstileSecret: str(v.turnstileSecret),
				});
				return ok(await settingsPage(nl), "Saved");
			case "emails":
				await nl.settings.update({
					confirmation: { subject: str(v.confirmSubject) || c.confirmation.subject, intro: str(v.confirmIntro) || c.confirmation.intro },
					welcome: { enabled: bool(v.welcomeEnabled), subject: str(v.welcomeSubject) || c.welcome.subject, content: str(v.welcomeContent) || c.welcome.content },
				});
				return ok(await settingsPage(nl), "Saved");
			case "autosend":
				await nl.settings.update({
					autoSend: {
						mode: (["off", "draft", "send"].includes(str(v.mode)) ? str(v.mode) : "off") as "off" | "draft" | "send",
						collection: str(v.collection),
						titleField: str(v.titleField) || "title",
						excerptField: str(v.excerptField) || "excerpt",
						bodyField: str(v.bodyField),
						extraFields: tagList(v.extraFields),
						urlPattern: str(v.urlPattern) || "/{collection}/{slug}",
						sendAtField: str(v.sendAtField),
						subjectTemplate: str(v.subjectTemplate) || "{title}",
						readMoreLabel: str(v.readMoreLabel),
						audience: str(v.audience) || "all",
						publishWeb: bool(v.publishWeb),
						webAccess: str(v.webAccess) === "members" ? "members" : "public",
					},
				});
				return ok(await settingsPage(nl), "Saved");
			case "referrals": {
				const milestones = str(v.milestones)
					.split(/\r?\n/)
					.map((l) => l.split("|").map((x) => x.trim()))
					.filter((p) => int(p[0]) > 0 && p[1])
					.map((p) => ({ count: int(p[0]), reward: p[1], ...(p[2] && { tag: p[2] }) }))
					.sort((a, b) => a.count - b.count);
				await nl.settings.update({ referrals: { enabled: bool(v.enabled), milestones } });
				return ok(await settingsPage(nl), "Saved");
			}
			case "sponsors":
				await nl.settings.update({
					sponsors: { enabled: bool(v.enabled), label: str(v.label) || "Sponsored by", hideForTags: tagList(v.hide), autoIssuesOnly: bool(v.autoOnly) },
				});
				return ok(await settingsPage(nl), "Saved");
		}
	}
	return renderPage(nl, i.page ?? "/");
}

async function renderPage(nl: Newsletter, page: string): Promise<AdminResponse> {
	if (page.startsWith("widget")) return widget(nl);
	switch (page.replace(/\/$/, "") || "/") {
		case "/":
			return overviewPage(nl);
		case "/campaigns":
			return campaignsPage(nl);
		case "/subscribers":
			return subscribersPage(nl);
		case "/audience":
			return audiencePage(nl);
		case "/automations":
			return automationsPage(nl);
		case "/sponsors":
			return sponsorsPage(nl);
		case "/settings":
			return settingsPage(nl);
		default:
			return page === "newsletter-overview" ? widget(nl) : overviewPage(nl);
	}
}

export async function handleAdmin(nl: Newsletter, input: unknown, user?: { role: number }): Promise<AdminResponse> {
	const i = (input ?? {}) as Interaction;
	const role = user?.role ?? 0;
	try {
		if (i.type === "page_load") return await renderPage(nl, i.page ?? "/");
		if (i.type === "block_action" || i.type === "form_submit") return await act(nl, i, role);
		return await renderPage(nl, "/");
	} catch (err) {
		const message = (err as Error)?.message ?? "Something went wrong";
		let fallback: AdminResponse;
		try {
			fallback = await renderPage(nl, i.page ?? "/");
		} catch {
			fallback = { blocks: [banner("The newsletter couldn't load", message, "error")] };
		}
		return { ...fallback, toast: { type: "error", message } };
	}
}
