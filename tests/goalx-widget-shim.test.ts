import { describe, expect, it } from "vitest";
import {
	assertSupported,
	GUARDED,
	GUARD_MARKER,
	patchGoalStateSource,
	revertGoalStateSource,
	UNGUARDED,
} from "../scripts/goalx-widget-hide.mjs";

const FIXTURE = [
	"\tfunction renderUI(ctx) {",
	"\t\tif (!widgetRegistered) {",
	'\t\t\tctx.ui.setWidget(GOAL_WIDGET_KEY, factory, { placement: "aboveEditor" });',
	"\t\t}",
	"\t\tif (!widgetRegistered) {",
	'\t\t\tctx.ui.setWidget(GOAL_WIDGET_KEY, factory, { placement: "aboveEditor" });',
	"\t\t}",
	"\t}",
].join("\n");

describe("goal x widget shim", () => {
	it("guards every registration site without changing default behaviour", () => {
		const result = patchGoalStateSource(FIXTURE);
		expect(result.changed).toBe(true);
		expect(result.guardedSites).toBe(2);
		expect(result.source).toContain(GUARD_MARKER);
		expect(result.source.split(GUARDED)).toHaveLength(3);
		expect(result.source).not.toContain(UNGUARDED);
		expect(result.source).toContain("ctx.ui.setWidget(GOAL_WIDGET_KEY");
	});

	it("is idempotent", () => {
		const once = patchGoalStateSource(FIXTURE);
		const twice = patchGoalStateSource(once.source);
		expect(twice.changed).toBe(false);
		expect(twice.guardedSites).toBe(2);
		expect(twice.source).toBe(once.source);
	});

	it("round-trips back to the original source", () => {
		const patched = patchGoalStateSource(FIXTURE).source;
		expect(revertGoalStateSource(patched).source).toBe(FIXTURE);
	});

	it("refuses sources with no registration site", () => {
		expect(patchGoalStateSource("export const nothing = 1;").error).toContain("no widget registration site");
	});

	it("refuses versions it was not verified against", () => {
		expect(() => assertSupported("0.34.1")).not.toThrow();
		expect(() => assertSupported("0.35.0")).toThrow(/0.34/);
		expect(() => assertSupported("0.33.9")).toThrow(/0.34/);
	});
});
