#!/usr/bin/env node
/**
 * Optional, reversible compatibility shim for Goal X's above-editor widget.
 *
 * Goal X 0.34.1 (latest) registers its focused-goal widget with
 * `ctx.ui.setWidget("goal", …, { placement: "aboveEditor" })` and exposes no
 * setting to hide it. Pi's widget keys are global and have no cross-extension
 * visibility API, so Atelier cannot clear that widget safely on its own.
 *
 * This script adds ONE opt-in guard to the installed Goal X build:
 *
 *   if (!widgetRegistered && process.env.PI_GOAL_HIDE_COMPACT_WIDGET !== "1") {
 *
 * Nothing changes unless the environment variable is set to `1`, so the default
 * behaviour is byte-identical once the guard is present. The original file is
 * backed up next to it and `--revert` restores it exactly.
 *
 * Usage:
 *   node scripts/goalx-widget-hide.mjs            # patch the installed Goal X
 *   node scripts/goalx-widget-hide.mjs --revert   # restore the backup
 *   node scripts/goalx-widget-hide.mjs --check    # report current state
 *   node scripts/goalx-widget-hide.mjs --root <dir-to-goal-x>
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const GUARD_MARKER = "process.env.PI_GOAL_HIDE_COMPACT_WIDGET";
export const GUARDED = `if (!widgetRegistered && ${GUARD_MARKER} !== "1") {`;
export const UNGUARDED = "if (!widgetRegistered) {";
export const BACKUP_SUFFIX = ".atelier-original";
const SUPPORTED_MAJOR_MINOR = "0.34.";

/**
 * Returns the patched source, or an error when the source is not a supported
 * Goal X build. Pure so it can be unit tested without touching disk.
 */
export function patchGoalStateSource(source) {
	if (source.includes(GUARDED)) return { changed: false, source, guardedSites: count(source, GUARDED) };
	const sites = count(source, UNGUARDED);
	if (sites === 0) {
		return {
			changed: false,
			source,
			guardedSites: 0,
			error: "no widget registration site found in goal-state.ts",
		};
	}
	return { changed: true, source: source.split(UNGUARDED).join(GUARDED), guardedSites: sites };
}

export function revertGoalStateSource(source) {
	const sites = count(source, GUARDED);
	return { changed: sites > 0, source: source.split(GUARDED).join(UNGUARDED), guardedSites: 0 };
}

const count = (value, needle) => value.split(needle).length - 1;

function candidateRoots() {
	const home = homedir();
	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(home, ".pi", "agent");
	return [
		join(agentDir, "npm", "node_modules", "pi-goal-x"),
		join(agentDir, "git", "github.com", "tmonk", "pi-goal-x"),
	];
}

export function resolveGoalXRoot(explicit) {
	if (explicit) return resolve(explicit);
	const found = candidateRoots().find((root) => existsSync(join(root, "extensions", "goal-state.ts")));
	if (!found) throw new Error("Cannot find an installed pi-goal-x with extensions/goal-state.ts");
	return found;
}

export function goalXVersion(root) {
	try {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		return typeof pkg.version === "string" ? pkg.version : "unknown";
	} catch {
		return "unknown";
	}
}

export function assertSupported(version) {
	if (!version.startsWith(SUPPORTED_MAJOR_MINOR)) {
		throw new Error(
			`This shim is verified against pi-goal-x ${SUPPORTED_MAJOR_MINOR}x only (found ${version}). ` +
				"Re-check the widget registration sites before patching.",
		);
	}
}

function main(argv) {
	const flag = argv.find((arg) => arg.startsWith("--"));
	const rootArgIndex = argv.indexOf("--root");
	const root = resolveGoalXRoot(rootArgIndex >= 0 ? argv[rootArgIndex + 1] : undefined);
	const file = join(root, "extensions", "goal-state.ts");
	const backup = `${file}${BACKUP_SUFFIX}`;
	const version = goalXVersion(root);

	if (flag === "--check") {
		const source = readFileSync(file, "utf8");
		console.log(`pi-goal-x ${version} at ${root}`);
		console.log(source.includes(GUARD_MARKER) ? "shim: installed" : "shim: not installed");
		console.log(
			process.env.PI_GOAL_HIDE_COMPACT_WIDGET === "1"
				? "widget: hidden (PI_GOAL_HIDE_COMPACT_WIDGET=1)"
				: "widget: shown (set PI_GOAL_HIDE_COMPACT_WIDGET=1 to hide)",
		);
		return 0;
	}

	if (flag === "--revert") {
		if (!existsSync(backup)) throw new Error(`No backup at ${backup}`);
		copyFileSync(backup, file);
		console.log(`Restored ${file} from backup.`);
		return 0;
	}

	// Refuse to touch rebuilds we have not verified.
	assertSupported(version);
	const source = readFileSync(file, "utf8");
	const result = patchGoalStateSource(source);
	if (result.error) throw new Error(result.error);
	if (!result.changed) {
		console.log(`Already patched (${result.guardedSites} guard sites). Nothing to do.`);
		return 0;
	}
	if (!existsSync(backup)) copyFileSync(file, backup);
	writeFileSync(file, result.source);
	console.log(`Patched ${result.guardedSites} widget registration site(s) in ${file}`);
	console.log(`Backup: ${backup}`);
	console.log("Widget stays visible until PI_GOAL_HIDE_COMPACT_WIDGET=1 is set.");
	return 0;
}

if (
	import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
	process.argv[1]?.endsWith("goalx-widget-hide.mjs")
) {
	try {
		process.exitCode = main(process.argv.slice(2));
	} catch (error) {
		console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
