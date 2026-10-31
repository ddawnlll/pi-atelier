/**
 * Opt-in read-only check against a real Goal X storage root.
 *
 *   PI_REAL_GOALS_ROOT="<path to .pi/goals>" npx vitest run tests/e2e-real-data.test.ts
 *
 * It never writes: the adapter is read-only by construction, and this test only asserts that real
 * files parse and produce a coherent view.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readGoalXView, readSessionGoalXFocus } from "../src/goalx.js";
import { buildGoalXPanel } from "../src/goalx-panel.js";

const root = process.env.PI_REAL_GOALS_ROOT;
const sessionFile = process.env.PI_REAL_SESSION;

/** Reads the session's `pi-goal-focus` entries exactly like the extension does. */
function sessionEntries(file: string | undefined): unknown[] {
	if (!file || !existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split(/\r?\n/)
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [JSON.parse(line)];
			} catch {
				return [];
			}
		});
}

describe.skipIf(!root || !existsSync(join(root, "")))("real goal storage", () => {
	it("parses the user's actual Goal X state without writing", () => {
		const cwd = process.env.PI_E2E_CWD ?? process.cwd();
		const focus = readSessionGoalXFocus(sessionEntries(sessionFile));
		const view = readGoalXView({
			cwd,
			env: { ...process.env, PI_GOAL_ROOT: root },
			maxLedgerBytes: 512 * 1024,
			...(focus ? { focus } : {}),
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
					sessionFocus: focus ?? null,
				},
				null,
				1,
			),
		);
		expect(view.available).toBe(true);
		if (focus?.focusedGoalId) {
			// The session's real focus must produce the real goal, not an empty panel.
			expect(view.focused).toBe(true);
			expect(view.goal?.id).toBe(focus.focusedGoalId);
			expect(view.goal?.objective.length).toBeGreaterThan(0);
			expect(view.progress.total).toBeGreaterThan(0);
		} else {
			expect(view.focused).toBe(false);
			expect(view.goal).toBeUndefined();
		}
		const panel = buildGoalXPanel(view);
		expect(panel.rows.length).toBeLessThanOrEqual(24);
		expect(panel.id).toBe("goalx:goal");
	});
});
