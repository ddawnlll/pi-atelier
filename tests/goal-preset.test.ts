import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, resolveConfig } from "../src/config.js";
import {
	applyDisplayTemplate,
	derivePresetIdentity,
	DISPLAY_TEMPLATES,
	TEMPLATE_NAMES,
} from "../src/display.js";
import { GOAL_FOCUS_SIDEBAR_PANEL_LAYOUT } from "../src/sidebar-panels.js";

const visible = (config: { sidebarPanelLayout: readonly { id: string; visible: boolean }[] }, id: string) =>
	config.sidebarPanelLayout.find((entry) => entry.id === id)?.visible;

const ids = (config: { sidebarPanelLayout: readonly { id: string; visible: boolean }[] }) =>
	config.sidebarPanelLayout.map((entry) => entry.id);

const REDUNDANT = ["agent", "activity", "usage", "tools"] as const;

describe("goal-focused preset", () => {
	it("is a real preset that resolves to its own identity", () => {
		expect(TEMPLATE_NAMES).toContain("goalfocus");
		expect(derivePresetIdentity(applyDisplayTemplate("goalfocus"))).toBe("goalfocus");
		expect(derivePresetIdentity(applyDisplayTemplate("editorial"))).toBe("editorial");
		expect(DISPLAY_TEMPLATES.goalfocus.density).toBe("compact");
	});

	it("hides the redundant panels without deleting them", () => {
		const { config } = resolveConfig({ user: { preset: "goalfocus" } });
		for (const id of REDUNDANT) {
			expect(visible(config, id)).toBe(false);
			expect(ids(config)).toContain(id);
		}
		expect(visible(config, "context")).toBe(true);
		expect(visible(config, "workspace")).toBe(true);
		expect(visible(config, "goalx:goal")).toBe(true);
	});

	it("keeps model, usage, and cost in the footer rail exactly once", () => {
		const { config } = resolveConfig({ user: { preset: "goalfocus" } });
		const shown = config.segmentLayout.filter((entry) => entry.visible).map((entry) => entry.id);
		expect(shown).toContain("model");
		expect(shown).toContain("metrics");
		expect(shown).toContain("context");
		expect(shown.filter((id) => id === "metrics")).toHaveLength(1);
		expect(shown).not.toContain("brand");
		expect(shown).not.toContain("statuses");
	});

	it("leaves every other preset on the default panel layout", () => {
		for (const preset of ["editorial", "minimal", "classic"] as const) {
			const { config } = resolveConfig({ user: { preset } });
			expect(config.sidebarPanelLayout).toEqual(DEFAULT_CONFIG.sidebarPanelLayout);
		}
	});

	it("never overrides an explicit user layout, and reverts when the preset changes back", () => {
		const custom = [
			{ id: "agent", visible: false },
			{ id: "context", visible: true },
		];
		const { config } = resolveConfig({ user: { preset: "goalfocus", sidebarPanelLayout: custom } });
		expect(visible(config, "agent")).toBe(false);
		expect(visible(config, "context")).toBe(true);
		expect(visible(config, "goalx:goal")).toBeUndefined();

		const reverted = resolveConfig({ user: { preset: "editorial" } }).config;
		expect(reverted.sidebarPanelLayout).toEqual(DEFAULT_CONFIG.sidebarPanelLayout);
	});

	it("exposes a stable goal-first ordering", () => {
		const order = GOAL_FOCUS_SIDEBAR_PANEL_LAYOUT.filter((entry) => entry.visible).map((entry) => entry.id);
		expect(order.slice(0, 3)).toEqual(["goalx:goal", "context", "workspace"]);
	});
});
