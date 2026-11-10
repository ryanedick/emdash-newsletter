/**
 * Automations (drip sequences): a trigger enrolls a subscriber, then each step
 * sends one email after its delay. Triggers: "subscribed" (confirmed),
 * "tag_added" (a specific tag), "manual" (enrolled from the admin or API).
 * An optional exit tag ends a subscriber's run as soon as they carry it
 * (e.g. stop a sales sequence once someone has bought).
 */
import type { Core, Subscriber } from "./core.ts";
import { changes } from "./db.ts";
import { newId, now, parseJson } from "./util.ts";

export type AutomationTrigger = "subscribed" | "tag_added" | "manual";

export interface AutomationStep {
	/** Hours after the previous step (or after enrollment, for the first). */
	delayHours: number;
	subject: string;
	preheader?: string;
	/** Markdown body (merge tags allowed). */
	content: string;
}

export interface Automation {
	id: string;
	name: string;
	trigger: AutomationTrigger;
	triggerValue: string | null;
	/** Subscribers with this tag leave the automation before their next email. */
	exitTag: string | null;
	status: "active" | "paused";
	steps: AutomationStep[];
	createdAt: number;
	updatedAt: number;
}

const HOUR = 3600_000;

function map(r: Record<string, unknown>): Automation {
	return {
		id: r.id as string,
		name: r.name as string,
		trigger: r.trigger as AutomationTrigger,
		triggerValue: (r.trigger_value as string) ?? null,
		exitTag: (r.exit_tag as string) || null,
		status: r.status === "active" ? "active" : "paused",
		steps: parseJson<AutomationStep[]>(r.steps, []),
		createdAt: r.created_at as number,
		updatedAt: r.updated_at as number,
	};
}

function cleanSteps(steps: unknown): AutomationStep[] {
	if (!Array.isArray(steps)) return [];
	return steps
		.filter((s) => s && typeof s.subject === "string" && typeof s.content === "string")
		.map((s) => ({
			delayHours: Math.max(0, Math.min(Number(s.delayHours) || 0, 24 * 365)),
			subject: String(s.subject).slice(0, 300),
			...(s.preheader && { preheader: String(s.preheader).slice(0, 300) }),
			content: String(s.content),
		}));
}

export async function listAutomations(core: Core): Promise<Automation[]> {
	const { results } = await core.db.prepare(`SELECT * FROM nl_automations ORDER BY created_at`).all();
	return results.map(map);
}

export async function getAutomation(core: Core, id: string): Promise<Automation | null> {
	const r = await core.db.prepare(`SELECT * FROM nl_automations WHERE id = ?`).bind(id).first();
	return r ? map(r) : null;
}

export async function saveAutomation(
	core: Core,
	input: {
		id?: string;
		name: string;
		trigger: AutomationTrigger;
		triggerValue?: string | null;
		exitTag?: string | null;
		status?: "active" | "paused";
		steps: AutomationStep[];
	},
): Promise<Automation> {
	const id = input.id ?? newId("au_");
	const trigger: AutomationTrigger = ["subscribed", "tag_added", "manual"].includes(input.trigger) ? input.trigger : "manual";
	await core.db
		.prepare(
			`INSERT INTO nl_automations (id, name, trigger, trigger_value, exit_tag, status, steps, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET name = excluded.name, trigger = excluded.trigger, trigger_value = excluded.trigger_value,
			   exit_tag = excluded.exit_tag, status = excluded.status, steps = excluded.steps, updated_at = excluded.updated_at`,
		)
		.bind(
			id,
			input.name.slice(0, 120),
			trigger,
			input.triggerValue ?? null,
			input.exitTag?.trim().slice(0, 80) || null,
			input.status ?? "paused",
			JSON.stringify(cleanSteps(input.steps)),
			now(),
			now(),
		)
		.run();
	return (await getAutomation(core, id))!;
}

export async function deleteAutomation(core: Core, id: string): Promise<void> {
	await core.db.batch([
		core.db.prepare(`DELETE FROM nl_automation_runs WHERE automation_id = ?`).bind(id),
		core.db.prepare(`UPDATE nl_outbox SET status = 'canceled' WHERE automation_id = ? AND status = 'queued'`).bind(id),
		core.db.prepare(`DELETE FROM nl_automations WHERE id = ?`).bind(id),
	]);
}

export async function enroll(core: Core, automation: Automation, subscriberId: string): Promise<boolean> {
	if (automation.steps.length === 0) return false;
	const res = await core.db
		.prepare(`INSERT OR IGNORE INTO nl_automation_runs (automation_id, subscriber_id, step, next_at, status, created_at) VALUES (?, ?, 0, ?, 'active', ?)`)
		.bind(automation.id, subscriberId, now() + automation.steps[0].delayHours * HOUR, now())
		.run();
	return changes(res) > 0;
}

/** Enrolls a subscriber in every active automation matching the trigger. */
export async function enrollTrigger(core: Core, trigger: AutomationTrigger, sub: Subscriber, value?: string): Promise<number> {
	const { results } = await core.db
		.prepare(`SELECT * FROM nl_automations WHERE status = 'active' AND trigger = ? AND (trigger_value IS NULL OR trigger_value = '' OR trigger_value = ?)`)
		.bind(trigger, value ?? "")
		.all();
	let n = 0;
	for (const r of results) if (await enroll(core, map(r), sub.id)) n++;
	return n;
}

export async function stopRuns(core: Core, subscriberId: string): Promise<void> {
	await core.db.prepare(`UPDATE nl_automation_runs SET status = 'stopped' WHERE subscriber_id = ? AND status = 'active'`).bind(subscriberId).run();
}

/** Advances due runs: queues the step's email and schedules the next step. */
export async function runAutomations(core: Core, limit = 500): Promise<{ queued: number; finished: number }> {
	const out = { queued: 0, finished: 0 };
	const { results } = await core.db
		.prepare(
			`SELECT r.automation_id, r.subscriber_id, r.step, a.steps, a.status AS a_status, s.status AS s_status, s.email,
			   (a.exit_tag IS NOT NULL AND EXISTS (SELECT 1 FROM nl_tags t WHERE t.subscriber_id = r.subscriber_id AND t.tag = a.exit_tag)) AS exited
			 FROM nl_automation_runs r
			 JOIN nl_automations a ON a.id = r.automation_id
			 JOIN nl_subscribers s ON s.id = r.subscriber_id
			 WHERE r.status = 'active' AND r.next_at <= ? LIMIT ?`,
		)
		.bind(now(), limit)
		.all<{ automation_id: string; subscriber_id: string; step: number; steps: string; a_status: string; s_status: string; email: string; exited: number }>();
	const stmts = [];
	for (const r of results) {
		if (r.a_status !== "active") continue; // paused: hold the run where it is
		const steps = parseJson<AutomationStep[]>(r.steps, []);
		if (r.s_status !== "active" || r.exited || r.step >= steps.length) {
			const status = r.s_status !== "active" ? "stopped" : r.exited ? "exited" : "done";
			stmts.push(core.db.prepare(`UPDATE nl_automation_runs SET status = ? WHERE automation_id = ? AND subscriber_id = ?`).bind(status, r.automation_id, r.subscriber_id));
			out.finished++;
			continue;
		}
		stmts.push(
			core.db
				.prepare(
					`INSERT OR IGNORE INTO nl_outbox (id, kind, automation_id, step, subscriber_id, email, priority, next_attempt_at, created_at)
					 VALUES (?, 'automation', ?, ?, ?, ?, 3, ?, ?)`,
				)
				.bind(newId("ob_"), r.automation_id, r.step, r.subscriber_id, r.email, now(), now()),
		);
		out.queued++;
		const next = r.step + 1;
		if (next < steps.length) {
			stmts.push(
				core.db
					.prepare(`UPDATE nl_automation_runs SET step = ?, next_at = ? WHERE automation_id = ? AND subscriber_id = ?`)
					.bind(next, now() + steps[next].delayHours * HOUR, r.automation_id, r.subscriber_id),
			);
		} else {
			stmts.push(core.db.prepare(`UPDATE nl_automation_runs SET step = ?, status = 'done' WHERE automation_id = ? AND subscriber_id = ?`).bind(next, r.automation_id, r.subscriber_id));
			out.finished++;
		}
	}
	for (let i = 0; i < stmts.length; i += 50) await core.db.batch(stmts.slice(i, i + 50));
	return out;
}

export async function automationStats(core: Core, id: string): Promise<{ active: number; done: number; stopped: number; exited: number; sent: number }> {
	const r = await core.db
		.prepare(
			`SELECT
			   SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
			   SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
			   SUM(CASE WHEN status = 'stopped' THEN 1 ELSE 0 END) AS stopped,
			   SUM(CASE WHEN status = 'exited' THEN 1 ELSE 0 END) AS exited
			 FROM nl_automation_runs WHERE automation_id = ?`,
		)
		.bind(id)
		.first<{ active: number | null; done: number | null; stopped: number | null; exited: number | null }>();
	const s = await core.db.prepare(`SELECT COUNT(*) AS n FROM nl_outbox WHERE automation_id = ? AND status = 'sent'`).bind(id).first<{ n: number }>();
	return { active: r?.active ?? 0, done: r?.done ?? 0, stopped: r?.stopped ?? 0, exited: r?.exited ?? 0, sent: s?.n ?? 0 };
}
