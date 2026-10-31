import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { buildGoalXPanel, GOALX_PANEL_ID, GOALX_PANEL_TITLE } from "../src/goalx-panel.js";
import {
	deriveGoalXCurrentTask,
	deriveGoalXProgress,
	parseGoalXRecord,
	type GoalXView,
} from "../src/goalx.js";
import { EMPTY_RUN_ACTIVITY } from "../src/run-activity.js";
import { buildSidebarSnapshot, renderSidebarLines } from "../src/sidebar.js";
import type { SidebarPanelData } from "../src/sidebar-panels.js";
import type { SidebarPanelLayout } from "../src/types.js";
import type { AtelierState } from "../src/types.js";

const theme = {
	name: "dark",
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const PARSED_GOAL = parseGoalXRecord(
	JSON.stringify({
		id: "goal-1",
		objective: "Make v8-next intrinsically auditable",
		status: "active",
		autoContinue: true,
		usage: { tokensUsed: 1000, activeSeconds: 60 },
		currentTaskId: "task-3",
		taskList: {
			tasks: [
				{ id: "task-1", title: "Audit core", status: "complete" },
				{ id: "task-2", title: "Telemetry repair", status: "complete" },
				{ id: "task-3", title: "CLI reporting", status: "pending" },
				{ id: "task-4", title: "Delivery", status: "pending" },
			],
		},
	}),
);
if (!PARSED_GOAL) throw new Error("fixture did not parse");
const GOAL: NonNullable<typeof PARSED_GOAL> = PARSED_GOAL;

function view(overrides: Record<string, unknown> = {}): GoalXView {
	return {
		available: true,
		focused: true,
		openGoalCount: 1,
		goal: GOAL,
		currentTask: deriveGoalXCurrentTask(GOAL),
		progress: deriveGoalXProgress(GOAL),
		audit: { phase: "idle", checksKnown: false, checks: [], findings: [] },
		unfocusedOpen: 0,
		storageRoot: "/tmp/goals",
		warnings: [],
		...overrides,
	} as GoalXView;
}

const rows = (value: GoalXView): string[] =>
	buildGoalXPanel(value).rows.map((row) => (typeof row === "string" ? row : row.text));
const joined = (value: GoalXView): string => rows(value).join("\n");

describe("goal panel composition", () => {
	it("shows status, objective, progress, current task, upcoming, and completed tasks", () => {
		const text = joined(view());
		expect(text).toContain("RUNNING");
		expect(text).toContain("Make v8-next intrinsically auditable");
		expect(text).toContain("Progress  2/4 · 50%");
		expect(text).toContain("▶ task-3 CLI reporting");
		expect(text).toContain("○ Delivery");
		expect(text).toContain("Distinguish".slice(0, 0) + "2 done");
	});

	it("labels an inferred current task instead of presenting it as executing", () => {
		const { currentTaskId: _omitted, ...withoutCurrent } = GOAL;
		const inferred = deriveGoalXCurrentTask(withoutCurrent);
		const text = joined(view({ currentTask: inferred }));
		expect(text).toContain("~ task-3 CLI reporting");
		expect(text).toContain("inferred focus");
		expect(text).not.toContain("▶");
	});

	it("shows paused and blocked reasons", () => {
		expect(joined(view({ goal: { ...GOAL, status: "paused", pauseReason: "waiting on user" } }))).toContain(
			"Paused: waiting on user",
		);
		expect(joined(view({ goal: { ...GOAL, status: "blocked", pauseReason: "no tests dir" } }))).toContain(
			"Blocker: no tests dir",
		);
	});

	it("renders subtask progress and the next subtask", () => {
		const goal = parseGoalXRecord(
			JSON.stringify({
				id: "goal-2",
				objective: "Nested work",
				status: "active",
				currentTaskId: "task-1",
				taskList: {
					tasks: [
						{
							id: "task-1",
							title: "Parent",
							status: "pending",
							subtasks: [
								{ id: "task-1-1", title: "Child done", status: "complete" },
								{ id: "task-1-2", title: "Child next", status: "pending" },
							],
						},
					],
				},
			}),
		);
		if (!goal) throw new Error("fixture did not parse");
		const text = joined(
			view({ goal, currentTask: deriveGoalXCurrentTask(goal), progress: deriveGoalXProgress(goal) }),
		);
		expect(text).toContain("subtasks 1/2");
		expect(text).toContain("▸ Child next");
	});

	it("says so when Goal X is absent or nothing is focused", () => {
		expect(joined(view({ available: false, focused: false }))).toContain("Goal X not detected");
		expect(joined(view({ focused: false, goal: undefined }))).toContain("No goal focused");
		expect(joined(view({ focused: false, goal: undefined, unfocusedOpen: 3 }))).toContain(
			"3 open · not focused",
		);
	});

	it("keeps the contribution within Atelier's 24-row limit", () => {
		const many = parseGoalXRecord(
			JSON.stringify({
				id: "goal-3",
				objective: "Many tasks",
				status: "active",
				taskList: {
					tasks: Array.from({ length: 40 }, (_, index) => ({
						id: `task-${index}`,
						title: `Task ${index}`,
						status: "pending",
					})),
				},
			}),
		);
		if (!many) throw new Error("fixture did not parse");
		const panel = buildGoalXPanel(view({ goal: many, currentTask: deriveGoalXCurrentTask(many) }));
		expect(panel.rows.length).toBeLessThanOrEqual(24);
		expect(panel.id).toBe(GOALX_PANEL_ID);
		expect(panel.title).toBe(GOALX_PANEL_TITLE);
	});
});

describe("auditor presentation", () => {
	const running = view({
		audit: {
			phase: "running",
			checksKnown: false,
			checks: [],
			decision: "pending",
			findings: [],
		},
	});

	it("shows a running audit as pending, never approved", () => {
		const text = joined(running);
		expect(text).toContain("AUDITOR · VERIFYING");
		expect(text).toContain("Decision: PENDING");
		expect(text).toContain("Checks: not persisted");
		expect(text).not.toContain("APPROVED");
		expect(text).not.toContain("✓ Objective");
		const auditRows = rows(running).slice(rows(running).indexOf("AUDITOR · VERIFYING"));
		expect(auditRows.join("\n")).not.toContain("%");
	});

	it("never fabricates a completion percentage", () => {
		expect(rows(running).some((row) => /audit.*\d+%/i.test(row))).toBe(false);
	});

	it("renders approved with the completion line", () => {
		const text = joined(
			view({
				audit: {
					phase: "approved",
					checksKnown: true,
					checks: [{ id: "decision", label: "Final decision", state: "passed" }],
					decision: "approved",
					verdict: "approved",
					report: "<approved/>",
					findings: [],
				},
			}),
		);
		expect(text).toContain("AUDIT · APPROVED");
		expect(text).toContain("Decision: APPROVED");
	});

	it("renders changes requested with findings and an open goal", () => {
		const text = joined(
			view({
				audit: {
					phase: "disapproved",
					checksKnown: true,
					checks: [{ id: "decision", label: "Final decision", state: "failed" }],
					decision: "changes_requested",
					verdict: "disapproved",
					report: "- replay invariant\n- test receipt",
					findings: ["replay invariant", "test receipt"],
				},
			}),
		);
		expect(text).toContain("CHANGES NEEDED");
		expect(text).toContain("Goal remains open");
		expect(text).toContain("- replay invariant");
		expect(text).toContain("- test receipt");
	});

	it("renders errors and skips distinctly", () => {
		expect(
			joined(
				view({
					audit: {
						phase: "error",
						checksKnown: true,
						checks: [{ id: "decision", label: "Final decision", state: "failed" }],
						decision: "error",
						verdict: "error",
						findings: ["provider failed"],
					},
				}),
			),
		).toContain("AUDIT · ERROR");
		expect(
			joined(
				view({
					audit: {
						phase: "skipped",
						checksKnown: false,
						checks: [],
						decision: "skipped",
						findings: [],
						reason: "user_aborted",
					},
				}),
			),
		).toContain("Reason: user_aborted");
	});
});

describe("untrusted text and width", () => {
	it("strips terminal control sequences from goal and task text", () => {
		const hostile = parseGoalXRecord(
			JSON.stringify({
				id: "goal-4",
				objective: "evil \u001b[31mred\u001b[0m objective",
				status: "active",
				taskList: { tasks: [{ id: "task-1", title: "bad \u0007title\u001b]0;x\u0007", status: "pending" }] },
			}),
		);
		if (!hostile) throw new Error("fixture did not parse");
		const text = joined(view({ goal: hostile, currentTask: deriveGoalXCurrentTask(hostile) }));
		expect(text).not.toContain("\u001b");
		expect(text).not.toContain("\u0007");
	});
});

// ── Rendered inside Atelier's real sidebar ─────────────────────────────────

const LAYOUT: SidebarPanelLayout = [
	{ id: GOALX_PANEL_ID, visible: true },
	{ id: "context", visible: true },
	{ id: "workspace", visible: true },
];

const config = { ...DEFAULT_CONFIG, sidebarPanelLayout: LAYOUT };

const state: AtelierState = {
	activity: "working",
	modelId: "deepseek-v4.1-flash",
	provider: "opencode-go",
	thinkingLevel: "low",
	branch: "main",
	dirty: true,
	workspacePulse: { status: "unavailable" },
	metrics: {
		usageAvailable: true,
		costAvailable: true,
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0.1,
		subscription: false,
		contextTokens: 1000,
		contextWindow: 100_000,
		contextPercent: 1,
		autoCompact: true,
	},
	extensionStatuses: [],
};

function panelFor(value: GoalXView): SidebarPanelData {
	const contribution = buildGoalXPanel(value);
	return {
		...contribution,
		id: contribution.id,
		source: "pi-atelier",
		rows: contribution.rows.map((row) => (typeof row === "string" ? { text: row } : row)),
	};
}

function renderLines(width: number, height: number, value: GoalXView = view()): string[] {
	const snapshot = buildSidebarSnapshot({
		state,
		cwd: "C:/repo",
		branchEntryCount: 1,
		activeToolCount: 0,
		availableToolCount: 4,
		runActivity: EMPTY_RUN_ACTIVITY,
		sidebarPanels: [panelFor(value)],
	});
	return renderSidebarLines(snapshot, config, theme, width, height, { colorEnabled: false });
}

describe("sidebar integration and responsive width", () => {
	it("renders the panel inside Atelier with no horizontal overflow", () => {
		for (const width of [24, 28, 30, 32, 34, 42, 60]) {
			for (const height of [12, 20, 40, 70]) {
				const lines = renderLines(width, height);
				for (const line of lines) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}
		}
	});

	it("keeps every line inside the width for a very long unicode objective", () => {
		const long = { ...view(), goal: { ...GOAL, objective: "工程".repeat(80) } };
		for (const width of [28, 30, 34]) {
			for (const line of renderLines(width, 50, long)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("keeps the goal panel visible in a short terminal", () => {
		const text = renderLines(32, 16).join("\n");
		expect(text).toContain("GOAL X");
		expect(text).toContain("Progress");
	});

	it("renders Goal X migration states without throwing", () => {
		for (const value of [
			view({ available: false, focused: false, goal: undefined, currentTask: undefined }),
			view({ focused: false, goal: undefined, currentTask: undefined }),
			view({ audit: { phase: "running", checksKnown: false, checks: [], findings: [] } }),
		]) {
			expect(() => renderLines(30, 30, value)).not.toThrow();
		}
	});
});
