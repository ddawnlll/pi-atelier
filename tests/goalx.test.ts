import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createGoalXReader,
	deriveGoalXAudit,
	deriveGoalXCurrentTask,
	deriveGoalXFocus,
	deriveGoalXProgress,
	extractGoalXFindings,
	findJsonObjectEnd,
	parseGoalXRecord,
	readGoalXView,
	resolveGoalXRoot,
	type GoalXLedgerEvent,
} from "../src/goalx.js";

const roots: string[] = [];

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "atelier-goalx-"));
	roots.push(dir);
	return dir;
}

function goalsDir(cwd: string): string {
	const root = join(cwd, ".pi", "goals");
	mkdirSync(root, { recursive: true });
	return root;
}

interface GoalFixtureOptions {
	id?: string;
	objective?: string;
	status?: string;
	currentTaskId?: string;
	tasks?: unknown[];
	autoContinue?: boolean;
	pauseReason?: string;
}

function goalContent(options: GoalFixtureOptions = {}): string {
	const record = {
		version: 3,
		id: options.id ?? "goal-1",
		objective: options.objective ?? "Ship the goal-focused sidebar",
		status: options.status ?? "active",
		autoContinue: options.autoContinue ?? true,
		usage: { tokensUsed: 1200, activeSeconds: 60 },
		sisyphus: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:10:00.000Z",
		...(options.pauseReason ? { pauseReason: options.pauseReason } : {}),
		...(options.currentTaskId ? { currentTaskId: options.currentTaskId } : {}),
		taskList: {
			tasks: options.tasks ?? [
				{ id: "task-1", title: "Audit core", status: "complete" },
				{ id: "task-2", title: "Telemetry repair", status: "complete" },
				{ id: "task-3", title: "CLI reporting", status: "pending" },
				{ id: "task-4", title: "Delivery", status: "pending" },
			],
			blockCompletion: true,
			proposedAt: "2026-01-01T00:01:00.000Z",
		},
	};
	return `${JSON.stringify(record, null, 2)}\n\n# Objective\n\n${record.objective}\n`;
}

function writeGoal(cwd: string, options: GoalFixtureOptions = {}): void {
	const root = goalsDir(cwd);
	writeFileSync(
		join(root, `active_goal_2026010100000000_${options.id ?? "goal-1"}.md`),
		goalContent(options),
	);
}

function writeLedger(cwd: string, events: unknown[]): void {
	const root = goalsDir(cwd);
	writeFileSync(
		join(root, "goal_events.jsonl"),
		`${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
	);
}

function writeCheckpoint(cwd: string, focusedGoalId: string | null, coveredEvents = 0): void {
	const root = goalsDir(cwd);
	writeFileSync(
		join(root, ".goal-ledger-checkpoint.json"),
		JSON.stringify({ version: 4, acc: { focusedGoalId }, coveredEvents }),
	);
}

afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const focusEvent = (goalId: string): unknown => ({
	type: "goal_focused",
	goalId,
	reason: "created",
	at: "2026-01-01T00:00:00.000Z",
});

describe("goal file parsing", () => {
	it("reads the leading JSON object and ignores the markdown body", () => {
		const goal = parseGoalXRecord(goalContent());
		expect(goal?.id).toBe("goal-1");
		expect(goal?.tasks).toHaveLength(4);
	});

	it("tolerates braces inside JSON strings when locating the object end", () => {
		const content = '{"id":"g","objective":"a { brace } in text","taskList":{"tasks":[]}}\nbody {not json}';
		const end = findJsonObjectEnd(content);
		expect(content.slice(0, end)).toBe(
			'{"id":"g","objective":"a { brace } in text","taskList":{"tasks":[]}}',
		);
	});

	it("rejects truncated, corrupted, and objective-less records", () => {
		expect(parseGoalXRecord('{"id":"g","objective":"x"')).toBeUndefined();
		expect(parseGoalXRecord('{"id":"g","objec')).toBeUndefined();
		expect(parseGoalXRecord('{"id":"g","objective":"  "}')).toBeUndefined();
		expect(parseGoalXRecord("not json at all")).toBeUndefined();
	});

	it("drops malformed tasks instead of failing the goal", () => {
		const goal = parseGoalXRecord(
			'{"id":"g","objective":"o","taskList":{"tasks":[{"id":"a","title":"ok","status":"pending"},{"id":1},{"id":"b"}]}}',
		);
		expect(goal?.tasks.map((task) => task.id)).toEqual(["a"]);
	});
});

describe("current task and progress semantics", () => {
	const goal = parseGoalXRecord(
		goalContent({
			tasks: [
				{ id: "task-1", title: "done", status: "complete" },
				{
					id: "task-2",
					title: "parent",
					status: "pending",
					subtasks: [
						{ id: "task-2-1", title: "child done", status: "complete" },
						{ id: "task-2-2", title: "child pending", status: "pending" },
					],
				},
				{ id: "task-3", title: "later", status: "pending" },
			],
		}),
	);
	if (!goal) throw new Error("fixture did not parse");

	it("uses an explicit currentTaskId when it references a pending task", () => {
		const view = deriveGoalXCurrentTask({ ...goal, currentTaskId: "task-3" });
		expect(view).toMatchObject({ id: "task-3", inferred: false });
	});

	it("accepts a nested subtask id", () => {
		const view = deriveGoalXCurrentTask({ ...goal, currentTaskId: "task-2-2" });
		expect(view).toMatchObject({ id: "task-2-2", depth: 1, inferred: false });
	});

	it("infers the first pending task when currentTaskId is absent, invalid, or settled", () => {
		expect(deriveGoalXCurrentTask(goal)?.inferred).toBe(true);
		expect(deriveGoalXCurrentTask(goal)?.id).toBe("task-2");
		expect(deriveGoalXCurrentTask({ ...goal, currentTaskId: "missing" })?.inferred).toBe(true);
		expect(deriveGoalXCurrentTask({ ...goal, currentTaskId: "task-1" })?.inferred).toBe(true);
	});

	it("returns no current task when everything is settled", () => {
		const done = parseGoalXRecord(
			goalContent({ tasks: [{ id: "task-1", title: "done", status: "complete" }] }),
		);
		if (!done) throw new Error("fixture did not parse");
		expect(deriveGoalXCurrentTask(done)).toBeUndefined();
	});

	it("counts top-level complete and skipped tasks only", () => {
		const mixed = parseGoalXRecord(
			goalContent({
				tasks: [
					{ id: "task-1", title: "a", status: "complete" },
					{ id: "task-2", title: "b", status: "skipped" },
					{ id: "task-3", title: "c", status: "pending" },
				],
			}),
		);
		if (!mixed) throw new Error("fixture did not parse");
		expect(deriveGoalXProgress(mixed)).toEqual({ completed: 2, total: 3, percentage: 67 });
	});

	it("reports zero progress for an empty task list", () => {
		expect(deriveGoalXProgress({ ...goal, tasks: [] })).toEqual({ completed: 0, total: 0, percentage: 0 });
	});
});

describe("ledger focus reconstruction", () => {
	it("starts from the checkpoint and applies later focus events", () => {
		const events: GoalXLedgerEvent[] = [
			{ type: "goal_focused", goalId: "a" },
			{ type: "goal_focused", goalId: "b" },
		];
		expect(deriveGoalXFocus(events, { focusedGoalId: "a", coveredEvents: 0 })).toBe("b");
		expect(deriveGoalXFocus(events, { focusedGoalId: "a", coveredEvents: 2 })).toBe("a");
	});

	it("clears focus on goal_unfocused and on the focused goal completing", () => {
		expect(
			deriveGoalXFocus([{ type: "goal_unfocused" }], { focusedGoalId: "a", coveredEvents: 0 }),
		).toBeNull();
		expect(
			deriveGoalXFocus([{ type: "goal_completed", goalId: "a" }], { focusedGoalId: "a", coveredEvents: 0 }),
		).toBeNull();
		expect(
			deriveGoalXFocus([{ type: "goal_completed", goalId: "b" }], { focusedGoalId: "a", coveredEvents: 0 }),
		).toBe("a");
	});
});

describe("audit derivation", () => {
	const auditOf = (events: unknown[], goalId = "goal-1") =>
		deriveGoalXAudit(events as GoalXLedgerEvent[], goalId);

	it("is idle without audit events", () => {
		expect(auditOf([{ type: "goal_focused", goalId: "goal-1" }]).phase).toBe("idle");
	});

	it("reports a running audit without inventing a percentage", () => {
		const audit = auditOf([{ type: "audit_started", goalId: "goal-1", at: "2026-01-01T00:00:00.000Z" }]);
		expect(audit.phase).toBe("running");
		expect(audit.checksKnown).toBe(false);
		expect(audit).not.toHaveProperty("percentage");
		expect(audit.checks.every((check) => check.estimated)).toBe(true);
	});

	it("derives approved, disapproved, and error result states from the ledger", () => {
		expect(
			auditOf([{ type: "audit_result", goalId: "goal-1", verdict: "approved", report: "<approved/>" }]).phase,
		).toBe("approved");
		const rejected = auditOf([
			{
				type: "audit_result",
				goalId: "goal-1",
				verdict: "disapproved",
				report: "Missing:\n- replay invariant\n- test receipt",
			},
		]);
		expect(rejected.phase).toBe("disapproved");
		expect(rejected.findings).toEqual(["replay invariant", "test receipt"]);
		expect(rejected.checks.find((check) => check.id === "decision")?.state).toBe("failed");
		expect(
			auditOf([{ type: "audit_result", goalId: "goal-1", verdict: "error", report: "boom" }]).phase,
		).toBe("error");
	});

	it("keeps the latest audit event and ignores other goals", () => {
		const audit = auditOf([
			{ type: "audit_result", goalId: "goal-1", verdict: "disapproved", report: "old" },
			{ type: "audit_result", goalId: "other", verdict: "approved", report: "<approved/>" },
			{ type: "audit_started", goalId: "goal-1" },
		]);
		expect(audit.phase).toBe("running");
	});

	it("reports a skipped audit with its reason", () => {
		const audit = auditOf([{ type: "audit_skipped", goalId: "goal-1", reason: "user_aborted" }]);
		expect(audit).toMatchObject({ phase: "skipped", reason: "user_aborted" });
	});

	it("extracts at most three findings and skips headers and attribution", () => {
		expect(extractGoalXFindings("Audit report:\nAuditor: gpt\n- a\n- b\n- c\n- d")).toEqual(["a", "b", "c"]);
	});
});

describe("view reading", () => {
	it("reports no storage without writing anything", () => {
		const cwd = workspace();
		const view = readGoalXView({ cwd });
		expect(view.available).toBe(false);
		expect(view.focused).toBe(false);
		expect(view.audit.phase).toBe("idle");
	});

	it("reads the focused goal, tasks, and audit state", () => {
		const cwd = workspace();
		writeGoal(cwd);
		writeLedger(cwd, [focusEvent("goal-1"), { type: "audit_started", goalId: "goal-1" }]);
		const view = readGoalXView({ cwd });
		expect(view.focused).toBe(true);
		expect(view.goal?.objective).toBe("Ship the goal-focused sidebar");
		expect(view.currentTask?.id).toBe("task-3");
		expect(view.progress).toEqual({ completed: 2, total: 4, percentage: 50 });
		expect(view.audit.phase).toBe("running");
	});

	it("never auto-selects a goal when the session is explicitly unfocused", () => {
		const cwd = workspace();
		writeGoal(cwd);
		writeLedger(cwd, [{ type: "goal_unfocused", reason: "user" }]);
		const view = readGoalXView({ cwd });
		expect(view.focused).toBe(false);
		expect(view.goal).toBeUndefined();
		expect(view.unfocusedOpen).toBe(1);
	});

	it("keeps the checkpoint focus when the ledger has no focus event", () => {
		const cwd = workspace();
		writeGoal(cwd);
		writeLedger(cwd, []);
		writeCheckpoint(cwd, "goal-1");
		expect(readGoalXView({ cwd }).goal?.id).toBe("goal-1");
	});

	it("survives a corrupted goal file and reports a warning for malformed ledger lines", () => {
		const cwd = workspace();
		const root = goalsDir(cwd);
		writeFileSync(join(root, "active_goal_1_goal-1.md"), "{ this is not json");
		writeFileSync(join(root, "goal_events.jsonl"), `${JSON.stringify(focusEvent("goal-1"))}\nnot-json\n`);
		const view = readGoalXView({ cwd });
		expect(view.focused).toBe(true);
		expect(view.goal).toBeUndefined();
		expect(view.warnings.join(" ")).toContain("malformed");
	});

	it("respects PI_GOAL_ROOT and the configured goalsRoot", () => {
		const cwd = workspace();
		const external = join(workspace(), "external-goals");
		mkdirSync(external, { recursive: true });
		writeFileSync(join(external, "active_goal_1_goal-1.md"), goalContent());
		writeFileSync(join(external, "goal_events.jsonl"), `${JSON.stringify(focusEvent("goal-1"))}\n`);
		expect(resolveGoalXRoot({ cwd, env: { PI_GOAL_ROOT: external } })).toBe(external);
		expect(readGoalXView({ cwd, env: { PI_GOAL_ROOT: external } }).goal?.id).toBe("goal-1");

		const configured = workspace();
		mkdirSync(join(configured, ".pi"), { recursive: true });
		writeFileSync(
			join(configured, ".pi", "pi-goal-x-settings.json"),
			JSON.stringify({ goalsRoot: external }),
		);
		expect(resolveGoalXRoot({ cwd: configured, env: {} })).toBe(external);
	});

	it("ignores relative or malformed goalsRoot values", () => {
		const cwd = workspace();
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "pi-goal-x-settings.json"),
			JSON.stringify({ goalsRoot: "relative/path" }),
		);
		expect(resolveGoalXRoot({ cwd, env: {} })).toBe(join(cwd, ".pi", "goals"));
	});

	it("still finds the audit when the ledger is larger than the read cap", () => {
		const cwd = workspace();
		writeGoal(cwd);
		const root = goalsDir(cwd);
		const padding = Array.from({ length: 500 }, (_, index) =>
			JSON.stringify({ type: "task_started", goalId: "goal-1", taskId: `pad-${index}` }),
		).join("\n");
		writeFileSync(join(root, "goal_events.jsonl"), `${padding}\n`);
		appendFileSync(
			join(root, "goal_events.jsonl"),
			`${JSON.stringify({ type: "audit_result", goalId: "goal-1", verdict: "approved", report: "ok" })}\n`,
		);
		writeCheckpoint(cwd, "goal-1");
		const view = readGoalXView({ cwd, maxLedgerBytes: 4096 });
		expect(view.audit.phase).toBe("approved");
		expect(view.goal?.id).toBe("goal-1");
	});
});

describe("cached reader", () => {
	it("re-reads only when an input stamp changes and disposes cleanly", () => {
		const cwd = workspace();
		writeGoal(cwd);
		writeLedger(cwd, [focusEvent("goal-1")]);
		const reader = createGoalXReader({ cwd, watch: false });
		const first = reader.view();
		expect(reader.view()).toBe(first);
		appendFileSync(
			join(goalsDir(cwd), "goal_events.jsonl"),
			`${JSON.stringify({ type: "audit_started", goalId: "goal-1" })}\n`,
		);
		expect(reader.view().audit.phase).toBe("running");
		reader.dispose();
		expect(reader.view().available).toBe(false);
	});

	it("notifies once after a watched directory change and stops after dispose", async () => {
		const cwd = workspace();
		writeGoal(cwd);
		writeLedger(cwd, [focusEvent("goal-1")]);
		let changes = 0;
		const reader = createGoalXReader({
			cwd,
			onChange: () => {
				changes += 1;
			},
		});
		appendFileSync(
			join(goalsDir(cwd), "goal_events.jsonl"),
			`${JSON.stringify({ type: "audit_started", goalId: "goal-1" })}\n`,
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
		reader.dispose();
		const seen = changes;
		appendFileSync(
			join(goalsDir(cwd), "goal_events.jsonl"),
			`${JSON.stringify({ type: "audit_result", goalId: "goal-1", verdict: "approved", report: "ok" })}\n`,
		);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(seen).toBeGreaterThan(0);
		expect(changes).toBe(seen);
	});
});
