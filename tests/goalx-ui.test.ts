import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { buildGoalXPanel, GOALX_PANEL_ID } from "../src/goalx-panel.js";
import {
	deriveGoalXCurrentTask,
	deriveGoalXProgress,
	parseGoalXRecord,
	type GoalXView,
} from "../src/goalx.js";
import { EMPTY_RUN_ACTIVITY } from "../src/run-activity.js";
import { buildSidebarSnapshot, renderSidebarLines } from "../src/sidebar.js";
import type { SidebarPanelData } from "../src/sidebar-panels.js";
import type { AtelierState, SidebarPanelLayout } from "../src/types.js";

const theme = { name: "dark", fg: (_c: string, text: string) => text, bold: (text: string) => text };

const parsed = parseGoalXRecord(
	JSON.stringify({
		id: "goal-1",
		objective: "Ship it",
		status: "active",
		currentTaskId: "task-2",
		taskList: {
			tasks: [
				{ id: "task-1", title: "Done", status: "complete" },
				{ id: "task-2", title: "Now", status: "pending" },
			],
		},
	}),
);
if (!parsed) throw new Error("fixture did not parse");

const VIEW: GoalXView = {
	available: true,
	focused: true,
	openGoalCount: 1,
	goal: parsed,
	currentTask: deriveGoalXCurrentTask(parsed),
	progress: deriveGoalXProgress(parsed),
	audit: { phase: "idle", checksKnown: false, checks: [], findings: [] },
	unfocusedOpen: 0,
	storageRoot: "/tmp/goals",
	warnings: [],
};

const PANEL: SidebarPanelData = {
	...buildGoalXPanel(VIEW),
	source: "pi-atelier",
	rows: buildGoalXPanel(VIEW).rows.map((row) => (typeof row === "string" ? { text: row } : row)),
};

const GOAL_LAYOUT: SidebarPanelLayout = [
	{ id: GOALX_PANEL_ID, visible: true },
	{ id: "context", visible: true },
];

const state: AtelierState = {
	activity: "ready",
	modelId: "deepseek-v4.1-flash",
	provider: "opencode-go",
	thinkingLevel: "low",
	branch: "main",
	dirty: false,
	workspacePulse: { status: "unavailable" },
	metrics: {
		usageAvailable: true,
		costAvailable: true,
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0.01,
		subscription: false,
		contextTokens: 10,
		contextWindow: 1000,
		contextPercent: 1,
		autoCompact: true,
	},
	extensionStatuses: [],
};

function render(options: {
	layout: SidebarPanelLayout;
	panels: SidebarPanelData[];
	width?: number;
	height?: number;
	color?: boolean;
}): string[] {
	const snapshot = buildSidebarSnapshot({
		state,
		cwd: "C:/repo",
		branchEntryCount: 1,
		activeToolCount: 0,
		availableToolCount: 2,
		runActivity: EMPTY_RUN_ACTIVITY,
		sidebarPanels: options.panels,
	});
	return renderSidebarLines(
		snapshot,
		{ ...DEFAULT_CONFIG, sidebarPanelLayout: options.layout },
		theme,
		options.width ?? 32,
		options.height ?? 40,
		{ colorEnabled: options.color ?? false },
	);
}

const text = (lines: string[]): string => lines.join("\n");

describe("UI integration", () => {
	it("load order A: layout knows the panel before any contribution arrives", () => {
		const lines = render({ layout: GOAL_LAYOUT, panels: [] });
		expect(text(lines)).not.toContain("GOAL X");
		expect(text(lines)).toContain("CONTEXT");
	});

	it("load order B: a contribution arriving for a configured layout renders", () => {
		const lines = render({ layout: GOAL_LAYOUT, panels: [PANEL] });
		expect(text(lines)).toContain("GOAL X");
		expect(text(lines)).toContain("▶ task-2 Now");
	});

	it("does not render a contribution the layout does not know", () => {
		const lines = render({ layout: [{ id: "context", visible: true }], panels: [PANEL] });
		expect(text(lines)).not.toContain("GOAL X");
	});

	it("unload/reload: removing the contribution leaves the rest intact", () => {
		const before = render({ layout: GOAL_LAYOUT, panels: [PANEL] });
		const after = render({ layout: GOAL_LAYOUT, panels: [] });
		expect(text(before)).toContain("GOAL X");
		expect(text(after)).not.toContain("GOAL X");
		expect(text(after)).toContain("CONTEXT");
	});

	it("keeps width and colors correct in both plain and colored modes", () => {
		for (const color of [false, true]) {
			for (const width of [28, 30, 32, 34, 44]) {
				const lines = render({ layout: GOAL_LAYOUT, panels: [PANEL], width, height: 24, color });
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				if (color) expect(lines.some((line) => line.includes("\u001b["))).toBe(true);
				else expect(lines.some((line) => line.includes("\u001b["))).toBe(false);
			}
		}
	});

	it("degrades on a small height without breaking the frame", () => {
		for (const height of [8, 10, 12, 14]) {
			const lines = render({ layout: GOAL_LAYOUT, panels: [PANEL], width: 32, height });
			expect(lines.length).toBeLessThanOrEqual(height + 2);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(32);
		}
	});
});
