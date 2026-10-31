/**
 * End-to-end scenario against a real Goal X storage layout.
 *
 * Opt-in: `PI_E2E=1 npx vitest run tests/e2e-goalx.test.ts`. The scenario writes only to a
 * temporary directory (never to a real goal root) and drives the same reader and sidebar renderer
 * the extension uses, so it exercises the real file formats and the real rendering path.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { buildGoalXPanel, GOALX_PANEL_ID } from "../src/goalx-panel.js";
import { createGoalXReader, readGoalXView } from "../src/goalx.js";
import { EMPTY_RUN_ACTIVITY } from "../src/run-activity.js";
import { buildSidebarSnapshot, renderSidebarLines } from "../src/sidebar.js";
import type { AtelierState, SidebarPanelLayout } from "../src/types.js";

const enabled = process.env.PI_E2E === "1";
const transcriptPath = process.env.PI_E2E_TRANSCRIPT;

const theme = { name: "dark", fg: (_c: string, text: string) => text, bold: (text: string) => text };

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
		cost: 0.004,
		subscription: false,
		contextTokens: 1200,
		contextWindow: 100_000,
		contextPercent: 1.2,
		autoCompact: true,
	},
	extensionStatuses: [],
};

const LAYOUT: SidebarPanelLayout = [
	{ id: GOALX_PANEL_ID, visible: true },
	{ id: "context", visible: true },
	{ id: "workspace", visible: true },
];
const config = { ...DEFAULT_CONFIG, sidebarPanelLayout: LAYOUT };

function renderGoalX(cwd: string, width = 32, height = 40): string[] {
	const view = readGoalXView({ cwd });
	const panel = { ...buildGoalXPanel(view), source: "pi-atelier" };
	const snapshot = buildSidebarSnapshot({
		state,
		cwd,
		branchEntryCount: 1,
		activeToolCount: 0,
		availableToolCount: 2,
		runActivity: EMPTY_RUN_ACTIVITY,
		sidebarPanels: [
			{ ...panel, rows: panel.rows.map((row) => (typeof row === "string" ? { text: row } : row)) },
		],
	});
	return renderSidebarLines(snapshot, config, theme, width, height, { colorEnabled: false });
}

interface Scenario {
	id: string;
	objective?: string;
	status?: string;
	currentTaskId?: string;
	tasks?: Array<Record<string, unknown>>;
}

function writeGoal(cwd: string, goal: Scenario): string {
	const root = join(cwd, ".pi", "goals");
	mkdirSync(root, { recursive: true });
	const file = join(root, `active_goal_2026010100000000_${goal.id}.md`);
	writeFileSync(
		file,
		`${JSON.stringify({
			version: 3,
			id: goal.id,
			objective: goal.objective ?? `Goal ${goal.id}`,
			status: goal.status ?? "active",
			autoContinue: true,
			usage: { tokensUsed: 500, activeSeconds: 30 },
			...(goal.currentTaskId ? { currentTaskId: goal.currentTaskId } : {}),
			taskList: {
				tasks: goal.tasks ?? [
					{ id: "task-1", title: "Audit core", status: "complete" },
					{ id: "task-2", title: "Final self-audit", status: "pending" },
					{ id: "task-3", title: "Delivery", status: "pending" },
				],
				blockCompletion: true,
				proposedAt: "2026-01-01T00:00:00.000Z",
			},
		})}\n`,
	);
	return root;
}

const log = (line: string): void => {
	if (transcriptPath) appendFileSync(transcriptPath, `${line}\n`);
};

describe.skipIf(!enabled)("goal x end-to-end scenario", () => {
	it("walks every lifecycle state on a real storage layout", () => {
		const cwd = mkdtempSync(join(tmpdir(), "atelier-e2e-"));
		const root = writeGoal(cwd, { id: "goal-a", objective: "Make v8-next auditable" });
		const ledger = join(root, "goal_events.jsonl");
		const steps: Array<[string, () => void, (text: string) => void]> = [];
		const widths: number[] = [];

		const render = (): string => {
			const lines = renderGoalX(cwd);
			for (const line of lines) {
				const width = visibleWidth(line);
				widths.push(width);
				expect(width).toBeLessThanOrEqual(32);
			}
			return lines.join("\n");
		};

		try {
			// 1-3: startup, Goal X init, synthetic goal focused.
			writeFileSync(
				ledger,
				`${JSON.stringify({ type: "goal_focused", goalId: "goal-a", at: "2026-01-01T00:00:00.000Z" })}\n`,
			);
			steps.push(["startup + focus", () => {}, (text) => expect(text).toContain("GOAL X")]);

			// 4: current-task change from the agent.
			const text1 = render();
			expect(text1).toContain("RUNNING");
			expect(text1).toContain("Progress  1/3 · 33%");
			expect(text1).toContain("~ task-2 Final self-audit");
			log(`\n=== 3. focused goal ===\n${text1}`);

			// 4b: explicit current task recorded by Goal X.
			writeGoal(cwd, { id: "goal-a", objective: "Make v8-next auditable", currentTaskId: "task-3" });
			const explicit = render();
			expect(explicit).toContain("▶ task-3 Delivery");
			expect(explicit).not.toContain("~ task-3");
			log(`\n=== 4. explicit current task ===\n${explicit}`);

			// 5: task completion.
			writeGoal(cwd, {
				id: "goal-a",
				objective: "Make v8-next auditable",
				tasks: [
					{ id: "task-1", title: "Audit core", status: "complete" },
					{ id: "task-2", title: "Final self-audit", status: "complete" },
					{ id: "task-3", title: "Delivery", status: "pending" },
				],
			});
			const completed = render();
			expect(completed).toContain("Progress  2/3 · 67%");
			log(`\n=== 5. task completion ===\n${completed}`);

			// 6: goal switching.
			writeGoal(cwd, { id: "goal-b", objective: "Second goal", currentTaskId: "task-1" });
			appendFileSync(
				ledger,
				`${JSON.stringify({ type: "goal_focused", goalId: "goal-b", at: "2026-01-01T00:01:00.000Z" })}\n`,
			);
			const switched = render();
			expect(switched).toContain("Second goal");
			log(`\n=== 6. goal switch ===\n${switched}`);

			// 7-8: audit start and pending decision.
			appendFileSync(
				ledger,
				`${JSON.stringify({ type: "completion_requested", goalId: "goal-b", at: "2026-01-01T00:02:00.000Z" })}\n`,
			);
			appendFileSync(
				ledger,
				`${JSON.stringify({ type: "audit_started", goalId: "goal-b", at: "2026-01-01T00:02:01.000Z" })}\n`,
			);
			const auditing = render();
			expect(auditing).toContain("AUDITOR · VERIFYING");
			expect(auditing).toContain("Decision: PENDING");
			expect(auditing).not.toContain("APPROVED");
			log(`\n=== 7-8. audit running / decision pending ===\n${auditing}`);

			// 9: approved.
			appendFileSync(
				ledger,
				`${JSON.stringify({ type: "audit_result", goalId: "goal-b", verdict: "approved", report: "<approved/>All contracts satisfied.", at: "2026-01-01T00:03:00.000Z" })}\n`,
			);
			const approved = render();
			expect(approved).toContain("AUDIT · APPROVED");
			expect(approved).toContain("Decision: APPROVED");
			log(`\n=== 9. approved ===\n${approved}`);

			// 10: rejected on a new goal.
			writeGoal(cwd, { id: "goal-c", objective: "Third goal" });
			appendFileSync(
				ledger,
				`${JSON.stringify({ type: "goal_focused", goalId: "goal-c", at: "2026-01-01T00:04:00.000Z" })}\n`,
			);
			appendFileSync(
				ledger,
				`${JSON.stringify({ type: "audit_result", goalId: "goal-c", verdict: "disapproved", report: "Missing evidence:\n- replay invariant\n- test receipt", at: "2026-01-01T00:05:00.000Z" })}\n`,
			);
			const rejected = render();
			expect(rejected).toContain("CHANGES NEEDED");
			expect(rejected).toContain("- replay invariant");
			log(`\n=== 10. changes requested ===\n${rejected}`);

			// 11: back to goal mode (new focus, no audit yet).
			appendFileSync(
				ledger,
				`${JSON.stringify({ type: "goal_focused", goalId: "goal-a", at: "2026-01-01T00:06:00.000Z" })}\n`,
			);
			const back = render();
			expect(back).toContain("Progress");
			expect(back).not.toContain("AUDITOR");
			log(`\n=== 11. return to goal mode ===\n${back}`);

			// 12: session reload — a fresh reader sees the same state.
			const reader = createGoalXReader({ cwd, watch: false });
			expect(reader.view().goal?.id).toBe("goal-a");
			reader.dispose();
			const reloaded = render();
			expect(reloaded).toContain("Make v8-next auditable");
			log(`\n=== 12. session reload ===\n${reloaded}`);

			// 13: terminal resize.
			for (const width of [24, 28, 30, 32, 34, 40, 60]) {
				const lines = renderGoalX(cwd, width, 12);
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
			log("\n=== 13. resize 24..60 columns: no overflow ===");
			log(`widths observed: min=${Math.min(...widths)} max=${Math.max(...widths)}`);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
		expect(steps.length).toBe(1);
	});
});
