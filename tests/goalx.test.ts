import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createGoalXReader,
	deriveGoalXAudit,
	deriveGoalXCurrentTask,
	deriveGoalXProgress,
	extractGoalXFindings,
	findJsonObjectEnd,
	parseGoalXRecord,
	readGoalXView,
	readSessionGoalXFocus,
	resolveGoalXRoot,
	type GoalXFocus,
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

const focusOn = (id: string | null, storageRoot?: string): GoalXFocus =>
	storageRoot ? { focusedGoalId: id, storageRoot } : { focusedGoalId: id };

interface GoalFixtureOptions {
	id?: string;
	objective?: string;
	status?: string;
	currentTaskId?: string;
	tasks?: unknown[];
	pauseReason?: string;
}

function goalContent(options: GoalFixtureOptions = {}): string {
	const record = {
		version: 3,
		id: options.id ?? "goal-1",
		objective: options.objective ?? "Ship the goal-focused sidebar",
		status: options.status ?? "active",
		autoContinue: true,
		usage: { tokensUsed: 1200, activeSeconds: 60 },
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
	writeFileSync(
		join(goalsDir(cwd), `active_goal_2026010100000000_${options.id ?? "goal-1"}.md`),
		goalContent(options),
	);
}

function writeLedger(cwd: string, events: unknown[]): void {
	writeFileSync(
		join(goalsDir(cwd), "goal_events.jsonl"),
		events.map((event) => JSON.stringify(event)).join("\n") + "\n",
	);
}

afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sessionEntry = (focusedGoalId: unknown, extra: Record<string, unknown> = {}): unknown => ({
	type: "custom",
	customType: "pi-goal-focus",
	data: { version: 1, focusedGoalId, reason: "created", ...extra },
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

describe("session focus", () => {
	it("reads the last pi-goal-focus entry", () => {
		expect(readSessionGoalXFocus([sessionEntry("g1"), sessionEntry("g2")])).toEqual({ focusedGoalId: "g2" });
	});

	it("honours an explicit unfocus and ignores non-focus entries", () => {
		expect(readSessionGoalXFocus([sessionEntry("g1"), sessionEntry(null)])).toEqual({ focusedGoalId: null });
		expect(
			readSessionGoalXFocus([
				{ type: "custom", customType: "pi-goal-event", data: { goalId: "g1" } },
				{ type: "message", customType: "pi-goal-focus", data: { focusedGoalId: "g2" } },
				{ type: "custom", customType: "pi-goal-focus", data: "nope" },
			]),
		).toBeUndefined();
	});

	it("keeps the storage root recorded with focus", () => {
		expect(readSessionGoalXFocus([sessionEntry("g1", { storageRoot: "/external/goals" })])).toEqual({
			focusedGoalId: "g1",
			storageRoot: "/external/goals",
		});
	});

	it("ignores malformed ids instead of guessing", () => {
		expect(readSessionGoalXFocus([sessionEntry("")])).toBeUndefined();
		expect(readSessionGoalXFocus([sessionEntry(42)])).toBeUndefined();
		expect(readSessionGoalXFocus([])).toBeUndefined();
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
		expect(deriveGoalXCurrentTask({ ...goal, currentTaskId: "task-3" })).toMatchObject({
			id: "task-3",
			inferred: false,
		});
	});

	it("accepts a nested subtask id", () => {
		expect(deriveGoalXCurrentTask({ ...goal, currentTaskId: "task-2-2" })).toMatchObject({
			id: "task-2-2",
			depth: 1,
			inferred: false,
		});
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

describe("audit derivation", () => {
	const auditOf = (events: unknown[], goalId = "goal-1") =>
		deriveGoalXAudit(events as GoalXLedgerEvent[], goalId);

	it("is idle without audit events", () => {
		expect(auditOf([{ type: "goal_focused", goalId: "goal-1" }]).phase).toBe("idle");
	});

	it("reports a running audit without checks or a percentage", () => {
		const audit = auditOf([{ type: "audit_started", goalId: "goal-1", at: "2026-01-01T00:00:00.000Z" }]);
		expect(audit).toMatchObject({ phase: "running", checksKnown: false, decision: "pending", checks: [] });
		expect(audit).not.toHaveProperty("percentage");
	});

	it("claims only the decision for a result, never per-check passes", () => {
		const rejected = auditOf([
			{
				type: "audit_result",
				goalId: "goal-1",
				verdict: "disapproved",
				report: "Missing evidence:\n- replay invariant\n- test receipt",
			},
		]);
		expect(rejected.phase).toBe("disapproved");
		expect(rejected.decision).toBe("changes_requested");
		expect(rejected.checks).toEqual([{ id: "decision", label: "Final decision", state: "failed" }]);
		expect(rejected.findings).toEqual(["replay invariant", "test receipt"]);

		const approved = auditOf([
			{ type: "audit_result", goalId: "goal-1", verdict: "approved", report: "<approved/>" },
		]);
		expect(approved.checks).toEqual([{ id: "decision", label: "Final decision", state: "passed" }]);
		expect(approved.decision).toBe("approved");
	});

	it("never marks a non-decision stage as passed or failed", () => {
		for (const verdict of ["approved", "disapproved", "error"]) {
			const audit = auditOf([{ type: "audit_result", goalId: "goal-1", verdict, report: "x" }]);
			expect(audit.checks.every((check) => check.id === "decision")).toBe(true);
		}
	});

	it("keeps the latest audit event and ignores other goals", () => {
		const audit = auditOf([
			{ type: "audit_result", goalId: "goal-1", verdict: "disapproved", report: "old" },
			{ type: "audit_result", goalId: "other", verdict: "approved", report: "<approved/>" },
			{ type: "audit_started", goalId: "goal-1" },
		]);
		expect(audit.phase).toBe("running");
	});

	it("tolerates out-of-order and repeated events by using the last one", () => {
		const audit = auditOf([
			{ type: "audit_result", goalId: "goal-1", verdict: "approved", report: "a" },
			{ type: "audit_result", goalId: "goal-1", verdict: "approved", report: "a" },
			{ type: "audit_result", goalId: "goal-1", verdict: "disapproved", report: "later" },
		]);
		expect(audit.phase).toBe("disapproved");
	});

	it("reports a skipped audit with its reason", () => {
		expect(auditOf([{ type: "audit_skipped", goalId: "goal-1", reason: "user_aborted" }])).toMatchObject({
			phase: "skipped",
			reason: "user_aborted",
			decision: "skipped",
		});
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
	});

	it("reads the session-focused goal, tasks, and audit state", () => {
		const cwd = workspace();
		writeGoal(cwd);
		writeLedger(cwd, [{ type: "audit_started", goalId: "goal-1" }]);
		const view = readGoalXView({ cwd, focus: focusOn("goal-1") });
		expect(view.focused).toBe(true);
		expect(view.goal?.objective).toBe("Ship the goal-focused sidebar");
		expect(view.currentTask?.id).toBe("task-3");
		expect(view.progress).toEqual({ completed: 2, total: 4, percentage: 50 });
		expect(view.audit.phase).toBe("running");
	});

	it("does not take focus from the ledger, ever", () => {
		const cwd = workspace();
		writeGoal(cwd);
		// Another session focused this goal; this session never did.
		writeLedger(cwd, [{ type: "goal_focused", goalId: "goal-1" }]);
		const view = readGoalXView({ cwd });
		expect(view.focused).toBe(false);
		expect(view.goal).toBeUndefined();
		expect(view.unfocusedOpen).toBe(1);
	});

	it("honours an explicit unfocus despite an existing goal", () => {
		const cwd = workspace();
		writeGoal(cwd);
		expect(readGoalXView({ cwd, focus: focusOn(null) }).focused).toBe(false);
	});

	it("shows only the session-focused goal from a pool of several", () => {
		const cwd = workspace();
		writeGoal(cwd, { id: "goal-a", objective: "First" });
		writeGoal(cwd, { id: "goal-b", objective: "Second" });
		const view = readGoalXView({ cwd, focus: focusOn("goal-b") });
		expect(view.goal?.objective).toBe("Second");
		expect(view.openGoalCount).toBe(2);
		expect(view.unfocusedOpen).toBe(1);
	});

	it("reports a focused goal whose record is gone instead of showing a stale goal", () => {
		const cwd = workspace();
		const root = goalsDir(cwd);
		writeFileSync(join(root, "goal_events.jsonl"), "\n");
		// No active record for the focused id: Goal X archived it or the root changed.
		const view = readGoalXView({ cwd, focus: focusOn("archived-goal") });
		expect(view.focused).toBe(true);
		expect(view.goal).toBeUndefined();
		expect(view.recordMissing).toBe(true);
		expect(view.progress).toEqual({ completed: 0, total: 0, percentage: 0 });
		expect(view.audit.phase).toBe("idle");
	});

	it("shows the newly focused goal after the previous one is archived", () => {
		const cwd = workspace();
		writeGoal(cwd, { id: "goal-old", objective: "Old goal" });
		writeGoal(cwd, { id: "goal-new", objective: "New goal" });
		const root = goalsDir(cwd);
		// Archive the old record exactly as Goal X does, then move focus.
		mkdirSync(join(root, "archived"), { recursive: true });
		renameSync(
			join(root, "active_goal_2026010100000000_goal-old.md"),
			join(root, "archived", "active_goal_2026010100000000_goal-old.md"),
		);
		const view = readGoalXView({ cwd, focus: focusOn("goal-new") });
		expect(view.goal?.objective).toBe("New goal");
		expect(view.recordMissing).toBeUndefined();
	});

	it("survives a corrupted goal file and reports malformed ledger lines", () => {
		const cwd = workspace();
		const root = goalsDir(cwd);
		writeFileSync(join(root, "active_goal_1_goal-1.md"), "{ this is not json");
		writeFileSync(join(root, "goal_events.jsonl"), "{}\nnot-json\n");
		const view = readGoalXView({ cwd, focus: focusOn("goal-1") });
		expect(view.focused).toBe(true);
		expect(view.goal).toBeUndefined();
		expect(view.warnings.join(" ")).toContain("malformed");
	});

	it("respects the session storage root, PI_GOAL_ROOT, and goalsRoot", () => {
		const cwd = workspace();
		const external = join(workspace(), "external-goals");
		mkdirSync(external, { recursive: true });
		writeFileSync(join(external, "active_goal_1_goal-1.md"), goalContent());
		writeFileSync(join(external, "goal_events.jsonl"), "\n");

		expect(resolveGoalXRoot({ cwd, focus: focusOn("goal-1", external) })).toBe(external);
		expect(readGoalXView({ cwd, focus: focusOn("goal-1", external) }).goal?.id).toBe("goal-1");
		expect(resolveGoalXRoot({ cwd, env: { PI_GOAL_ROOT: external } })).toBe(external);

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
		const view = readGoalXView({ cwd, focus: focusOn("goal-1"), maxLedgerBytes: 4096 });
		expect(view.audit.phase).toBe("approved");
		expect(view.goal?.id).toBe("goal-1");
	});
});

describe("cached reader", () => {
	it("re-reads only when a file stamp or the session focus changes", () => {
		const cwd = workspace();
		writeGoal(cwd);
		writeLedger(cwd, []);
		let focus: GoalXFocus = focusOn("goal-1");
		const reader = createGoalXReader({ cwd, watch: false, getFocus: () => focus });
		const first = reader.view();
		expect(first.focused).toBe(true);
		expect(reader.view()).toBe(first);
		focus = focusOn(null);
		expect(reader.view().focused).toBe(false);
		focus = focusOn("goal-1");
		appendFileSync(
			join(goalsDir(cwd), "goal_events.jsonl"),
			`${JSON.stringify({ type: "audit_started", goalId: "goal-1" })}\n`,
		);
		expect(reader.view().audit.phase).toBe("running");
		reader.dispose();
		expect(reader.view().available).toBe(false);
	});

	it("refreshes when only the goal record changes and the ledger does not", () => {
		const cwd = workspace();
		writeGoal(cwd, {
			id: "goal-1",
			tasks: [
				{ id: "task-1", title: "One", status: "complete" },
				{ id: "task-2", title: "Two", status: "pending" },
			],
		});
		writeLedger(cwd, []);
		const reader = createGoalXReader({ cwd, watch: false, focus: focusOn("goal-1") });
		expect(reader.view().progress).toEqual({ completed: 1, total: 2, percentage: 50 });
		// Goal X rewrites the record; no ledger event is appended in this case.
		writeGoal(cwd, {
			id: "goal-1",
			tasks: [
				{ id: "task-1", title: "One", status: "complete" },
				{ id: "task-2", title: "Two", status: "complete" },
				{ id: "task-3", title: "Three", status: "pending" },
			],
		});
		expect(reader.view().progress).toEqual({ completed: 2, total: 3, percentage: 67 });
		reader.dispose();
	});

	it("notifies once after a watched change and stops after dispose", async () => {
		const cwd = workspace();
		writeGoal(cwd);
		writeLedger(cwd, []);
		let changes = 0;
		const reader = createGoalXReader({
			cwd,
			focus: focusOn("goal-1"),
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
