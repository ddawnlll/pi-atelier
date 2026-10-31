/**
 * Opt-in read-only check against a real Goal X storage root.
 *
 *   PI_REAL_GOALS_ROOT="<path to .pi/goals>" npx vitest run tests/e2e-real-data.test.ts
 *
 * It never writes: the adapter is read-only by construction, and this test only asserts that real
 * files parse and produce a coherent view.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readGoalXView } from "../src/goalx.js";
import { buildGoalXPanel } from "../src/goalx-panel.js";

const root = process.env.PI_REAL_GOALS_ROOT;

describe.skipIf(!root || !existsSync(join(root, "")))("real goal storage", () => {
	it("parses the user's actual Goal X state without writing", () => {
		const cwd = process.env.PI_E2E_CWD ?? process.cwd();
		const view = readGoalXView({
			cwd,
			env: { ...process.env, PI_GOAL_ROOT: root },
			maxLedgerBytes: 512 * 1024,
		});
		console.log(
			JSON.stringify(
				{
					root,
					available: view.available,
					focused: view.focused,
					goalId: view.goal?.id,
					status: view.goal?.status,
					tasks: view.progress,
					currentTask: view.currentTask && { id: view.currentTask.id, inferred: view.currentTask.inferred },
					audit: view.audit.phase,
					openGoals: view.openGoalCount,
					warnings: view.warnings,
				},
				null,
				1,
			),
		);
		expect(view.available).toBe(true);
		const panel = buildGoalXPanel(view);
		expect(panel.rows.length).toBeLessThanOrEqual(24);
		expect(panel.id).toBe("goalx:goal");
	});
});
