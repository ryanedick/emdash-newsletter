/**
 * Sponsor slots: one ad per date, shown in the issue that goes out that day
 * (in the publication's time zone). Subscribers carrying any of
 * `sponsors.hideForTags` (e.g. paying members) never see it.
 *
 * Statuses: "hold" (pencilled in, not yet confirmed), "booked", "canceled".
 * Holds and bookings both reserve the date; only bookings are shown in email.
 */
import type { Core } from "./core.ts";
import type { NewsletterConfig } from "./settings.ts";
import { escapeHtml, newId, now } from "./util.ts";
import { type EmailStyles, safeUrl } from "./render/styles.ts";

export type SponsorStatus = "hold" | "booked" | "canceled";

export interface SponsorSlot {
	id: string;
	/** YYYY-MM-DD in the publication time zone. */
	date: string;
	status: SponsorStatus;
	sponsor: string;
	headline: string;
	/** Short Markdown-free copy, 1–3 sentences. */
	body: string;
	url: string;
	ctaLabel: string | null;
	imageUrl: string | null;
	contactEmail: string | null;
	priceCents: number | null;
	notes: string | null;
	/** The first campaign that carried this ad. */
	campaignId: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface SponsorInput {
	date: string;
	status?: SponsorStatus;
	sponsor: string;
	headline: string;
	body?: string;
	url: string;
	ctaLabel?: string | null;
	imageUrl?: string | null;
	contactEmail?: string | null;
	priceCents?: number | null;
	notes?: string | null;
}

export type SponsorSaveResult = { ok: true; slot: SponsorSlot } | { ok: false; reason: "invalid" | "date_taken" | "not_found"; detail: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function map(r: Record<string, unknown>): SponsorSlot {
	const status = r.status === "hold" || r.status === "canceled" ? (r.status as SponsorStatus) : "booked";
	return {
		id: r.id as string,
		date: r.date as string,
		status,
		sponsor: r.sponsor as string,
		headline: r.headline as string,
		body: (r.body as string) ?? "",
		url: r.url as string,
		ctaLabel: (r.cta_label as string) ?? null,
		imageUrl: (r.image_url as string) ?? null,
		contactEmail: (r.contact_email as string) ?? null,
		priceCents: (r.price_cents as number) ?? null,
		notes: (r.notes as string) ?? null,
		campaignId: (r.campaign_id as string) ?? null,
		createdAt: r.created_at as number,
		updatedAt: r.updated_at as number,
	};
}

const clip = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

function validate(input: SponsorInput): { ok: true; value: Required<SponsorInput> } | { ok: false; detail: string } {
	const date = (input.date ?? "").trim();
	if (!DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return { ok: false, detail: "Date must be YYYY-MM-DD." };
	const sponsor = clip(input.sponsor, 120);
	const headline = clip(input.headline, 200);
	if (!sponsor) return { ok: false, detail: "Sponsor name is required." };
	if (!headline) return { ok: false, detail: "Headline is required." };
	const url = safeUrl(input.url ?? "");
	if (!url || !/^https?:\/\//i.test(url)) return { ok: false, detail: "Link must be an http(s) URL." };
	const imageUrl = clip(input.imageUrl, 1000);
	if (imageUrl && !/^https:\/\//i.test(imageUrl)) return { ok: false, detail: "Image URL must be https." };
	const status: SponsorStatus = input.status === "hold" || input.status === "canceled" ? input.status : "booked";
	const price = input.priceCents === null || input.priceCents === undefined || !Number.isFinite(Number(input.priceCents)) ? null : Math.max(0, Math.round(Number(input.priceCents)));
	return {
		ok: true,
		value: {
			date,
			status,
			sponsor,
			headline,
			body: clip(input.body, 600) ?? "",
			url,
			ctaLabel: clip(input.ctaLabel, 60),
			imageUrl,
			contactEmail: clip(input.contactEmail, 254),
			priceCents: price,
			notes: clip(input.notes, 2000),
		},
	};
}

function isUniqueViolation(err: unknown): boolean {
	return /UNIQUE constraint failed/i.test(String((err as Error)?.message ?? err));
}

export async function getSponsorSlot(core: Core, id: string): Promise<SponsorSlot | null> {
	const r = await core.db.prepare(`SELECT * FROM nl_sponsor_slots WHERE id = ?`).bind(id).first();
	return r ? map(r) : null;
}

/** Slots between two dates (inclusive), canceled ones only when asked. */
export async function listSponsorSlots(core: Core, opts: { from?: string; to?: string; includeCanceled?: boolean } = {}): Promise<SponsorSlot[]> {
	const { results } = await core.db
		.prepare(
			`SELECT * FROM nl_sponsor_slots WHERE date >= ? AND date <= ? ${opts.includeCanceled ? "" : "AND status <> 'canceled'"} ORDER BY date, created_at`,
		)
		.bind(opts.from ?? "0000-00-00", opts.to ?? "9999-12-31")
		.all();
	return results.map(map);
}

/** The live (held or booked) slot for a date, if any. */
export async function sponsorForDate(core: Core, date: string): Promise<SponsorSlot | null> {
	const r = await core.db.prepare(`SELECT * FROM nl_sponsor_slots WHERE date = ? AND status <> 'canceled'`).bind(date).first();
	return r ? map(r) : null;
}

/** Books (or holds) a date. Fails with `date_taken` when the date already has a live slot. */
export async function bookSponsorSlot(core: Core, input: SponsorInput): Promise<SponsorSaveResult> {
	const v = validate(input);
	if (!v.ok) return { ok: false, reason: "invalid", detail: v.detail };
	const s = v.value;
	const id = newId("sp_");
	try {
		await core.db
			.prepare(
				`INSERT INTO nl_sponsor_slots (id, date, status, sponsor, headline, body, url, cta_label, image_url, contact_email, price_cents, notes, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(id, s.date, s.status, s.sponsor, s.headline, s.body, s.url, s.ctaLabel, s.imageUrl, s.contactEmail, s.priceCents, s.notes, now(), now())
			.run();
	} catch (err) {
		if (isUniqueViolation(err)) return { ok: false, reason: "date_taken", detail: `${s.date} is already booked.` };
		throw err;
	}
	return { ok: true, slot: (await getSponsorSlot(core, id))! };
}

/** Replaces a slot's details (moving it to another free date is allowed). */
export async function updateSponsorSlot(core: Core, id: string, input: SponsorInput): Promise<SponsorSaveResult> {
	if (!(await getSponsorSlot(core, id))) return { ok: false, reason: "not_found", detail: "That sponsor slot no longer exists." };
	const v = validate(input);
	if (!v.ok) return { ok: false, reason: "invalid", detail: v.detail };
	const s = v.value;
	try {
		await core.db
			.prepare(
				`UPDATE nl_sponsor_slots SET date = ?, status = ?, sponsor = ?, headline = ?, body = ?, url = ?, cta_label = ?, image_url = ?,
				   contact_email = ?, price_cents = ?, notes = ?, updated_at = ? WHERE id = ?`,
			)
			.bind(s.date, s.status, s.sponsor, s.headline, s.body, s.url, s.ctaLabel, s.imageUrl, s.contactEmail, s.priceCents, s.notes, now(), id)
			.run();
	} catch (err) {
		if (isUniqueViolation(err)) return { ok: false, reason: "date_taken", detail: `${s.date} is already booked.` };
		throw err;
	}
	return { ok: true, slot: (await getSponsorSlot(core, id))! };
}

/** Cancels a slot, which frees its date. */
export async function cancelSponsorSlot(core: Core, id: string): Promise<SponsorSlot | null> {
	await core.db.prepare(`UPDATE nl_sponsor_slots SET status = 'canceled', updated_at = ? WHERE id = ?`).bind(now(), id).run();
	return getSponsorSlot(core, id);
}

export async function deleteSponsorSlot(core: Core, id: string): Promise<void> {
	await core.db.prepare(`DELETE FROM nl_sponsor_slots WHERE id = ?`).bind(id).run();
}

/** Remembers which campaign first carried a slot (for the sponsor's report). */
export async function markSponsorSent(core: Core, id: string, campaignId: string): Promise<void> {
	await core.db.prepare(`UPDATE nl_sponsor_slots SET campaign_id = COALESCE(campaign_id, ?), updated_at = ? WHERE id = ?`).bind(campaignId, now(), id).run();
}

/** Every date in a range with its slot (or null when free), for the inventory calendar. */
export async function sponsorCalendar(core: Core, from: string, days: number): Promise<{ date: string; slot: SponsorSlot | null }[]> {
	if (!DATE.test(from)) throw new Error("from must be YYYY-MM-DD");
	const n = Math.max(1, Math.min(Math.round(days), 366));
	const start = Date.parse(`${from}T00:00:00Z`);
	const dates = Array.from({ length: n }, (_, i) => new Date(start + i * 86400_000).toISOString().slice(0, 10));
	const slots = await listSponsorSlots(core, { from: dates[0], to: dates[dates.length - 1] });
	const byDate = new Map(slots.map((s) => [s.date, s]));
	return dates.map((date) => ({ date, slot: byDate.get(date) ?? null }));
}

/** Clicks on the sponsor's link in the campaign that carried it. */
export async function sponsorClicks(core: Core, slot: SponsorSlot): Promise<{ clicks: number; unique: number } | null> {
	if (!slot.campaignId) return null;
	const r = await core.db
		.prepare(
			`SELECT COUNT(*) AS clicks, COUNT(DISTINCT e.outbox_id) AS uniq FROM nl_events e JOIN nl_links l ON l.id = e.link_id
			 WHERE e.type = 'click' AND e.campaign_id = ? AND l.url = ?`,
		)
		.bind(slot.campaignId, slot.url)
		.first<{ clicks: number; uniq: number }>();
	return { clicks: r?.clicks ?? 0, unique: r?.uniq ?? 0 };
}

/** The ad block for the email layout. */
export function renderSponsorBlock(slot: SponsorSlot, config: NewsletterConfig, s: EmailStyles): { html: string; text: string } {
	const label = escapeHtml(config.sponsors.label || "Sponsored by");
	const muted = "font:600 11px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Helvetica,Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#6b7079";
	const url = escapeHtml(slot.url);
	const img = slot.imageUrl ? `<a href="${url}"><img src="${escapeHtml(slot.imageUrl)}" alt="${escapeHtml(slot.sponsor)}" style="${s.img}"></a>` : "";
	const html = `<div style="margin:8px 0 0;padding:18px 20px;border:1px solid #e5e5ea;border-radius:12px">
<p style="margin:0 0 8px;${muted}">${label} ${escapeHtml(slot.sponsor)}</p>${img}
<p style="${s.heading(3).replace(/margin:[^;]+/, "margin:0 0 8px")}"><a href="${url}" style="color:inherit;text-decoration:none">${escapeHtml(slot.headline)}</a></p>
${slot.body ? `<p style="${s.p}">${escapeHtml(slot.body)}</p>` : ""}
<p style="margin:0"><a href="${url}" style="${s.link}">${escapeHtml(slot.ctaLabel || "Learn more")} →</a></p></div>`;
	const text = [`${config.sponsors.label || "Sponsored by"} ${slot.sponsor}`.toUpperCase(), slot.headline, slot.body, `${slot.ctaLabel || "Learn more"}: ${slot.url}`]
		.filter(Boolean)
		.join("\n");
	return { html, text };
}
