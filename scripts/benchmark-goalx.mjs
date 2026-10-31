#!/usr/bin/env node
/**
 * Measures what the Goal X panel costs in Atelier's real sidebar renderer.
 *
 * The upstream `bench:sidebar` renders Atelier's built-in panel set only, so it cannot show the
 * cost of the contributed panel. This harness renders the same snapshot with and without the panel
 * and reports medians for both, using the shared source sandbox.
 */
import { createSourceSandbox } from "./lib/source-sandbox.mjs";

const WIDTH = 32;
const HEIGHT = 40;
const WARMUPS = 5;
const SAMPLES = 30;

const sandbox = createSourceSandbox("atelier-goalx-bench-");
const { renderSidebarLines, buildSidebarSnapshot } = await sandbox.load("sidebar.js");
const { buildGoalXPanel } = await sandbox.load("goalx-panel.js");
const { EMPTY_RUN_ACTIVITY } = await sandbox.load("run-activity.js");
const { DEFAULT_CONFIG } = await sandbox.load("config.js");

const theme = { name: "dark", fg: (_c, text) => text, bold: (text) => text };
const state = {
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
		input: 1000,
		output: 200,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0.01,
		subscription: false,
		contextTokens: 1200,
		contextWindow: 100000,
		contextPercent: 1.2,
		autoCompact: true,
	},
	extensionStatuses: [],
};

const goal = {
	id: "goal-1",
	objective: "Make v8-next intrinsically auditable",
	status: "active",
	autoContinue: true,
	currentTaskId: "task-5",
	usage: { tokensUsed: 1000, activeSeconds: 60 },
	tasks: [
		{ id: "task-1", title: "Audit core", status: "complete" },
		{ id: "task-2", title: "Telemetry repair", status: "complete" },
		{ id: "task-3", title: "CLI reporting", status: "complete" },
		{ id: "task-4", title: "Validation tests", status: "complete" },
		{ id: "task-5", title: "Final self-audit", status: "pending" },
		{ id: "task-6", title: "Delivery", status: "pending" },
	],
};

const view = {
	available: true,
	focused: true,
	openGoalCount: 1,
	goal,
	currentTask: {
		id: "task-5",
		title: "Final self-audit",
		depth: 0,
		inferred: false,
		completedSubtasks: 0,
		totalSubtasks: 0,
	},
	progress: { completed: 4, total: 6, percentage: 67 },
	audit: {
		phase: "running",
		checksKnown: false,
		checks: [],
		decision: "pending",
		findings: [],
	},
	unfocusedOpen: 0,
	storageRoot: "/tmp/goals",
	warnings: [],
};

function timeWith(panels) {
	const snapshot = buildSidebarSnapshot({
		state,
		cwd: "/repo",
		branchEntryCount: 10,
		activeToolCount: 0,
		availableToolCount: 4,
		runActivity: EMPTY_RUN_ACTIVITY,
		sidebarPanels: panels,
	});
	for (let index = 0; index < WARMUPS; index += 1)
		renderSidebarLines(snapshot, DEFAULT_CONFIG, theme, WIDTH, HEIGHT, { colorEnabled: false });
	const samples = [];
	for (let index = 0; index < SAMPLES; index += 1) {
		const start = process.hrtime.bigint();
		renderSidebarLines(snapshot, DEFAULT_CONFIG, theme, WIDTH, HEIGHT, { colorEnabled: false });
		samples.push(Number(process.hrtime.bigint() - start) / 1e6);
	}
	samples.sort((left, right) => left - right);
	return {
		medianMs: Number(samples[Math.floor(samples.length / 2)].toFixed(4)),
		minMs: Number(samples[0].toFixed(4)),
		maxMs: Number(samples[samples.length - 1].toFixed(4)),
	};
}

const panel = { ...buildGoalXPanel(view), source: "pi-atelier" };
const layoutWith = [
	{ id: "goalx:goal", visible: true },
	{ id: "context", visible: true },
	{ id: "workspace", visible: true },
];
const without = timeWith([]);
const withPanel = timeWith([panel]);
const configWith = { ...DEFAULT_CONFIG, sidebarPanelLayout: layoutWith };

function timeLayout(config, panels) {
	const snapshot = buildSidebarSnapshot({
		state,
		cwd: "/repo",
		branchEntryCount: 10,
		activeToolCount: 0,
		availableToolCount: 4,
		runActivity: EMPTY_RUN_ACTIVITY,
		sidebarPanels: panels,
	});
	for (let index = 0; index < WARMUPS; index += 1)
		renderSidebarLines(snapshot, config, theme, WIDTH, HEIGHT, { colorEnabled: false });
	const samples = [];
	for (let index = 0; index < SAMPLES; index += 1) {
		const start = process.hrtime.bigint();
		renderSidebarLines(snapshot, config, theme, WIDTH, HEIGHT, { colorEnabled: false });
		samples.push(Number(process.hrtime.bigint() - start) / 1e6);
	}
	samples.sort((left, right) => left - right);
	return {
		medianMs: Number(samples[Math.floor(samples.length / 2)].toFixed(4)),
		minMs: Number(samples[0].toFixed(4)),
		maxMs: Number(samples[samples.length - 1].toFixed(4)),
	};
}

const report = {
	node: process.version,
	platform: `${process.platform}/${process.arch}`,
	width: WIDTH,
	height: HEIGHT,
	warmups: WARMUPS,
	samples: SAMPLES,
	defaultLayoutWithoutPanel: without,
	defaultLayoutWithContribution: withPanel,
	goalFocusedLayout: timeLayout(configWith, [panel]),
};
console.log(JSON.stringify(report, null, 2));
sandbox.dispose();
