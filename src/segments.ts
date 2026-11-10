/**
 * Segments: saved audience rules compiled to SQL over nl_subscribers.
 *
 * Rule fields:
 *   tag            has | not_has            value: tag
 *   topic          has | not_has            value: topic slug (stored as tag "topic:<slug>")
 *   source         eq | neq | starts_with   value
 *   email          contains | ends_with     value
 *   attr.<key>     eq | neq | contains | exists
 *   created_at     before | after | within_days
 *   confirmed_at   before | after | within_days
 *   opened         within_days | not_within_days   value: days
 *   clicked        within_days | not_within_days   value: days
 *   referrals      gte                              value: count
 */
import type { Core } from "./core.ts";
import { newId, now, parseJson } from "./util.ts";

export interface SegmentCondition {
	field: string;
	op: string;
	value?: string | number;
}

export interface SegmentRules {
	match: "all" | "any";
	conditions: SegmentCondition[];
}

export interface Segment {
	id: string;
	name: string;
	rules: SegmentRules;
	createdAt: number;
	updatedAt: number;
}

/** Who a campaign goes to. Combined with AND: segment rules, a topic, explicit rules. */
export interface Audience {
	segmentId?: string | null;
	topic?: string | null;
	rules?: SegmentRules | null;
}

const DAY = 86400_000;

function condition(c: SegmentCondition, binds: unknown[]): string | null {
	const v = c.value;
	const num = Number(v);
	switch (c.field) {
		case "tag":
		case "topic": {
			const tag = c.field === "topic" ? `topic:${v}` : String(v ?? "");
			binds.push(tag);
			const sub = `EXISTS (SELECT 1 FROM nl_tags t WHERE t.subscriber_id = s.id AND t.tag = ?)`;
			return c.op === "not_has" ? `NOT ${sub}` : sub;
		}
		case "source":
			if (c.op === "starts_with") {
				binds.push(`${v}%`);
				return "s.source LIKE ?";
			}
			binds.push(String(v ?? ""));
			return c.op === "neq" ? "(s.source IS NULL OR s.source <> ?)" : "s.source = ?";
		case "email":
			binds.push(c.op === "ends_with" ? `%${v}` : `%${v}%`);
			return "s.email LIKE ?";
		case "created_at":
		case "confirmed_at": {
			const col = `s.${c.field}`;
			if (c.op === "within_days") {
				binds.push(now() - num * DAY);
				return `${col} >= ?`;
			}
			const ts = typeof v === "number" ? v : Date.parse(String(v));
			if (Number.isNaN(ts)) return null;
			binds.push(ts);
			return c.op === "before" ? `${col} < ?` : `${col} >= ?`;
		}
		case "opened":
		case "clicked": {
			const col = c.field === "opened" ? "s.last_open_at" : "s.last_click_at";
			binds.push(now() - num * DAY);
			return c.op === "not_within_days" ? `(${col} IS NULL OR ${col} < ?)` : `${col} >= ?`;
		}
		case "referrals":
			binds.push(Number.isFinite(num) ? num : 1);
			return `(SELECT COUNT(*) FROM nl_subscribers r WHERE r.referred_by = s.id AND r.status = 'active') >= ?`;
		default: {
			if (!c.field.startsWith("attr.")) return null;
			const key = c.field.slice(5).replace(/[^A-Za-z0-9_-]/g, "");
			if (!key) return null;
			const path = `'$.${key}'`;
			if (c.op === "exists") return `json_extract(s.attributes, ${path}) IS NOT NULL`;
			if (c.op === "contains") {
				binds.push(`%${v}%`);
				return `json_extract(s.attributes, ${path}) LIKE ?`;
			}
			binds.push(String(v ?? ""));
			return c.op === "neq" ? `COALESCE(json_extract(s.attributes, ${path}), '') <> ?` : `json_extract(s.attributes, ${path}) = ?`;
		}
	}
}

export function compileRules(rules: SegmentRules | null | undefined, binds: unknown[]): string | null {
	if (!rules?.conditions?.length) return null;
	const parts = rules.conditions.map((c) => condition(c, binds)).filter((p): p is string => !!p);
	if (!parts.length) return null;
	return `(${parts.join(rules.match === "any" ? " OR " : " AND ")})`;
}

/** WHERE clause (over alias `s`) for active, unsuppressed subscribers in an audience. */
export async function audienceWhere(core: Core, audience: Audience): Promise<{ where: string; binds: unknown[] }> {
	const binds: unknown[] = [];
	const parts = ["s.status = 'active'", "NOT EXISTS (SELECT 1 FROM nl_suppressions x WHERE x.email = s.email)"];
	if (audience.segmentId) {
		const seg = await getSegment(core, audience.segmentId);
		if (!seg) throw new Error(`Segment ${audience.segmentId} not found`);
		const sql = compileRules(seg.rules, binds);
		if (sql) parts.push(sql);
	}
	if (audience.topic) {
		binds.push(`topic:${audience.topic}`);
		parts.push("EXISTS (SELECT 1 FROM nl_tags t WHERE t.subscriber_id = s.id AND t.tag = ?)");
	}
	const extra = compileRules(audience.rules, binds);
	if (extra) parts.push(extra);
	return { where: parts.join(" AND "), binds };
}

export async function countAudience(core: Core, audience: Audience): Promise<number> {
	const { where, binds } = await audienceWhere(core, audience);
	const r = await core.db.prepare(`SELECT COUNT(*) AS n FROM nl_subscribers s WHERE ${where}`).bind(...binds).first<{ n: number }>();
	return r?.n ?? 0;
}

function map(r: Record<string, unknown>): Segment {
	return {
		id: r.id as string,
		name: r.name as string,
		rules: parseJson<SegmentRules>(r.rules, { match: "all", conditions: [] }),
		createdAt: r.created_at as number,
		updatedAt: r.updated_at as number,
	};
}

export function validateRules(rules: unknown): SegmentRules {
	const r = rules as SegmentRules;
	if (!r || !Array.isArray(r.conditions)) throw new Error("Segment rules need a conditions array");
	return {
		match: r.match === "any" ? "any" : "all",
		conditions: r.conditions
			.filter((c) => c && typeof c.field === "string" && typeof c.op === "string")
			.map((c) => ({ field: c.field, op: c.op, ...(c.value !== undefined && { value: c.value }) })),
	};
}

export async function createSegment(core: Core, input: { name: string; rules: SegmentRules }): Promise<Segment> {
	const id = newId("seg_");
	const rules = validateRules(input.rules);
	await core.db
		.prepare(`INSERT INTO nl_segments (id, name, rules, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
		.bind(id, input.name.slice(0, 120), JSON.stringify(rules), now(), now())
		.run();
	return (await getSegment(core, id))!;
}

export async function updateSegment(core: Core, id: string, input: { name?: string; rules?: SegmentRules }): Promise<Segment | null> {
	const cur = await getSegment(core, id);
	if (!cur) return null;
	await core.db
		.prepare(`UPDATE nl_segments SET name = ?, rules = ?, updated_at = ? WHERE id = ?`)
		.bind((input.name ?? cur.name).slice(0, 120), JSON.stringify(input.rules ? validateRules(input.rules) : cur.rules), now(), id)
		.run();
	return getSegment(core, id);
}

export async function getSegment(core: Core, id: string): Promise<Segment | null> {
	const r = await core.db.prepare(`SELECT * FROM nl_segments WHERE id = ?`).bind(id).first();
	return r ? map(r) : null;
}

export async function listSegments(core: Core): Promise<Segment[]> {
	const { results } = await core.db.prepare(`SELECT * FROM nl_segments ORDER BY name`).all();
	return results.map(map);
}

export async function deleteSegment(core: Core, id: string): Promise<void> {
	await core.db.prepare(`DELETE FROM nl_segments WHERE id = ?`).bind(id).run();
}

/** Parses the compact text form used in the admin: one condition per line, `field op value`. */
export function parseRulesText(text: string, match: "all" | "any" = "all"): SegmentRules {
	const conditions: SegmentCondition[] = [];
	for (const line of text.split(/\r?\n/)) {
		const t = line.trim();
		if (!t || t.startsWith("#")) continue;
		const [field, op, ...rest] = t.split(/\s+/);
		if (!field || !op) continue;
		const raw = rest.join(" ");
		conditions.push({ field, op, ...(raw && { value: /^\d+$/.test(raw) ? Number(raw) : raw }) });
	}
	return { match, conditions };
}

export function rulesToText(rules: SegmentRules): string {
	return rules.conditions.map((c) => [c.field, c.op, c.value ?? ""].join(" ").trim()).join("\n");
}
