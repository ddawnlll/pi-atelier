/**
 * Extension-level integration: mounts Atelier's real extension through its lifecycle
 * (session_start → sidebar mount → teammate events → shutdown) against a real Goal X
 * storage layout and the real config resolver, then reads the rendered sidebar.
 *
 * This is the closest reproducible stand-in for an interactive Pi run: the same
 * ExtensionAPI handlers, the same config, the same sidebar controller and renderer.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { DEFAULT_SIDEBAR_WIDTH } from "../src/split-pane.js";
import { harness, start } from "./helpers/extension.js";
import { stripAnsi } from "./helpers/render.js";

const dirs: string[] = [];

function project(options: {
	goals?: Array<{ id: string; objective: string; tasks?: unknown[] }>;
	noGoalX?: boolean;
}): string {
	const cwd = mkdtempSync(join(tmpdir(), "atelier-ext-"));
	dirs.push(cwd);
	if (options.noGoalX) return cwd;
	const root = join(cwd, ".pi", "goals");
	mkdirSync(root, { recursive: true });
	for (const goal of options.goals ?? []) {
		writeFileSync(
			join(root, `active_goal_2026010100000000_${goal.id}.md`),
			JSON.stringify({
				id: goal.id,
				objective: goal.objective,
				status: "active",
				autoContinue: false,
				taskList: {
					tasks: goal.tasks ?? [
						{ id: "task-1", title: "Audit core", status: "complete" },
						{ id: "task-2", title: "Final self-audit", status: "pending" },
						{ id: "task-3", title: "Delivery", status: "pending" },
					],
				},
			}),
		);
	}
	writeFileSync(join(root, "goal_events.jsonl"), "\n");
	return cwd;
}

const focusEntry = (focusedGoalId: string | null) => ({
	type: "custom",
	customType: "pi-goal-focus",
	data: { version: 1, focusedGoalId, reason: "created" },
});

function configFor(preset: string) {
	return resolveConfig({ user: { preset } }).config;
}

async function mount(options: { cwd: string; preset: string; focus: string | null }) {
	const config = configFor(options.preset);
	const h = harness("tui", "linux", false, {
		loadConfig: async () => ({
			config,
			warnings: [],
			displayLayers: {},
			displayProvenance: {} as never,
		}),
	});
	h.ctx.cwd = options.cwd;
	h.ctx.sessionManager.getBranch.mockReturnValue([focusEntry(options.focus)]);
	await start(h);
	await h.dispatch("turn_start", { type: "turn_start" });
	await h.dispatch("turn_end", { type: "turn_end" });
	return h;
}

function sidebar(h: Awaited<ReturnType<typeof mount>>, width = 120): string {
	const overlay = h.overlays.at(-1);
	if (!overlay) throw new Error("sidebar was not mounted");
	return stripAnsi(overlay.component.render(width).join("\n"));
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("extension-level goal x integration", () => {
	it("renders the session-focused goal in the goal-focused preset", async () => {
		const cwd = project({ goals: [{ id: "goal-a", objective: "Make v8-next auditable" }] });
		const h = await mount({ cwd, preset: "goalfocus", focus: "goal-a" });
		const text = sidebar(h);
		expect(text).toContain("GOAL X");
		expect(text).toContain("Make v8-next auditable");
		expect(text).toContain("Progress 1/3 · 33%");
		expect(text).toContain("~ task-2 Final self-audit");
		expect(text).toContain("CONTEXT");
		expect(text).not.toContain("AGENT");
		expect(text).not.toContain("USAGE");
	});

	it("leaves the editorial preset exactly as upstream (AGENT, no Goal X panel)", async () => {
		const cwd = project({ goals: [{ id: "goal-a", objective: "Hidden here" }] });
		const h = await mount({ cwd, preset: "editorial", focus: "goal-a" });
		const text = sidebar(h);
		expect(text).toContain("AGENT");
		expect(text).not.toContain("GOAL X");
	});

	it("shows only the focused goal from a pool of several", async () => {
		const cwd = project({
			goals: [
				{ id: "goal-a", objective: "First goal" },
				{ id: "goal-b", objective: "Second goal" },
			],
		});
		const h = await mount({ cwd, preset: "goalfocus", focus: "goal-b" });
		const text = sidebar(h);
		expect(text).toContain("Second goal");
		expect(text).not.toContain("First goal");
	});

	it("follows a focus change and an explicit unfocus", async () => {
		const cwd = project({ goals: [{ id: "goal-a", objective: "Focusable" }] });
		const h = await mount({ cwd, preset: "goalfocus", focus: "goal-a" });
		expect(sidebar(h)).toContain("Focusable");
		h.ctx.sessionManager.getBranch.mockReturnValue([focusEntry("goal-a"), focusEntry(null)]);
		await h.dispatch("turn_end", { type: "turn_end" });
		const unfocused = sidebar(h);
		expect(unfocused).not.toContain("Focusable");
		expect(unfocused).toContain("No goal focused");
	});

	it("stays useful when Goal X is not installed", async () => {
		const cwd = project({ noGoalX: true });
		const h = await mount({ cwd, preset: "goalfocus", focus: null });
		const text = sidebar(h);
		expect(text).toContain("GOAL X");
		expect(text).toMatch(/Goal X not detected|No goal focused/);
		// The rest of the layout still renders.
		expect(text).toContain("CONTEXT");
	});

	it("keeps the sidebar inside its width with a very long task title", async () => {
		const cwd = project({
			goals: [
				{
					id: "goal-a",
					objective: "Long title stress",
					tasks: [{ id: "task-1", title: "x".repeat(400), status: "pending" }],
				},
			],
		});
		const h = await mount({ cwd, preset: "goalfocus", focus: "goal-a" });
		const lines = stripAnsi(h.overlays.at(-1)!.component.render(120).join("\n")).split("\n");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(120);
		expect(lines.some((line) => line.includes("…"))).toBe(true);
	});

	it("reloads cleanly: shutdown then a new session still renders", async () => {
		const cwd = project({ goals: [{ id: "goal-a", objective: "Reload goal" }] });
		const first = await mount({ cwd, preset: "goalfocus", focus: "goal-a" });
		await first.dispatch("session_shutdown", { reason: "quit" });
		const second = await mount({ cwd, preset: "goalfocus", focus: "goal-a" });
		expect(sidebar(second)).toContain("Reload goal");
	});

	it("does not add or override keyboard shortcuts", async () => {
		const cwd = project({ goals: [{ id: "goal-a", objective: "Shortcuts" }] });
		const h = await mount({ cwd, preset: "goalfocus", focus: "goal-a" });
		const config = configFor("goalfocus");
		// F6 is the control centre; the only other upstream binding is the resize chord.
		expect(h.shortcuts).toEqual(expect.arrayContaining([config.shortcut, "ctrl+shift+r"]));
		expect(h.shortcuts).toHaveLength(2);
		expect(config.toggleShortcut).toBe("");
	});

	it("keeps the sidebar width stable across repeated state events", async () => {
		const cwd = project({ goals: [{ id: "goal-a", objective: "Stable width" }] });
		const h = await mount({ cwd, preset: "goalfocus", focus: "goal-a" });
		const first = h.overlays.at(-1)!.component.render(120);
		await h.dispatch("turn_end", { type: "turn_end" });
		await h.dispatch("turn_end", { type: "turn_end" });
		const second = h.overlays.at(-1)!.component.render(120);
		expect(second.length).toBe(first.length);
		expect(stripAnsi(second.join("\n"))).toContain("Stable width");
		expect(DEFAULT_SIDEBAR_WIDTH).toBeGreaterThanOrEqual(30);
	});
});
