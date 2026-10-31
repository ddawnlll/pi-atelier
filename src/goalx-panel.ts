/**
 * Renders a Goal X view into Atelier sidebar panel rows.
 *
 * Pure: no I/O, no timers, no state. Rows are plain text so Atelier clips them to
 * the live sidebar width with its own Unicode-aware truncation, and the role names
 * map onto Atelier's palette (no hardcoded ANSI).
 */
import type { SidebarPanelContribution, SidebarPanelRole } from "./sidebar-panels.js";
import { sanitizeInline } from "./text.js";
import type { GoalXAudit, GoalXAuditCheck, GoalXTask, GoalXView } from "./goalx.js";

export const GOALX_PANEL_ID = "goalx:goal" as const;
export const GOALX_PANEL_TITLE = "GOAL X" as const;

type Row = { text: string; role: SidebarPanelRole };

/** Soft character budget per row; Atelier still hard-clips to the live width. */
const ROW_BUDGET = 56;

const MARK = {
	passed: "✓",
	running: "◉",
	pending: "○",
	failed: "✕",
	complete: "✓",
	skipped: "–",
} as const;

const statusRow = (view: GoalXView): Row => {
	if (!view.available) return { text: "Goal X not detected", role: "dim" };
	if (!view.focused) return { text: "No goal focused", role: "muted" };
	const goal = view.goal;
	if (!goal) return { text: view.recordMissing ? "Goal record not found" : "Reading goal…", role: "caution" };
	switch (goal.status) {
		case "active":
			return { text: goal.autoContinue ? "RUNNING · AUTO" : "RUNNING", role: "working" };
		case "paused":
			return { text: "PAUSED", role: "warning" };
		case "blocked":
			return { text: "BLOCKED", role: "error" };
		case "budget_limited":
			return { text: "BUDGET LIMITED", role: "caution" };
		case "complete":
			return { text: "COMPLETE", role: "success" };
	}
};

const meter = (percentage: number, cells = 8): string => {
	const filled = Math.max(0, Math.min(cells, Math.round((percentage / 100) * cells)));
	return "█".repeat(filled) + "░".repeat(cells - filled);
};

const cut = (text: string, budget = ROW_BUDGET): string => {
	const safe = sanitizeInline(text);
	const chars = Array.from(safe);
	return chars.length <= budget ? safe : `${chars.slice(0, Math.max(0, budget - 1)).join("")}…`;
};

const taskMark = (task: GoalXTask): string =>
	task.status === "complete" ? MARK.complete : task.status === "skipped" ? MARK.skipped : MARK.pending;

/** Flattens with depth so nested subtasks read as such without extra chrome. */
function flatten(tasks: readonly GoalXTask[], depth = 0): Array<{ task: GoalXTask; depth: number }> {
	const flat: Array<{ task: GoalXTask; depth: number }> = [];
	for (const task of tasks) {
		flat.push({ task, depth });
		if (task.subtasks && task.subtasks.length > 0) flat.push(...flatten(task.subtasks, depth + 1));
	}
	return flat;
}

const checkRow = (check: GoalXAuditCheck): Row => {
	const role: SidebarPanelRole =
		check.state === "passed"
			? "success"
			: check.state === "failed"
				? "error"
				: check.state === "running"
					? "working"
					: "dim";
	const mark =
		check.state === "passed"
			? MARK.passed
			: check.state === "failed"
				? MARK.failed
				: check.state === "running"
					? MARK.running
					: MARK.pending;
	return { text: `${mark} ${cut(check.label, 30)}`, role };
};

const auditHeadline = (audit: GoalXAudit): Row => {
	switch (audit.phase) {
		case "running":
			return { text: "AUDITOR · VERIFYING", role: "working" };
		case "approved":
			return { text: "AUDIT · APPROVED", role: "success" };
		case "disapproved":
			return { text: "AUDIT · CHANGES NEEDED", role: "error" };
		case "error":
			return { text: "AUDIT · ERROR", role: "error" };
		case "skipped":
			return { text: "AUDIT · SKIPPED", role: "dim" };
		default:
			return { text: "AUDIT · NOT STARTED", role: "dim" };
	}
};

function auditRows(audit: GoalXAudit): Row[] {
	if (audit.phase === "idle") return [];
	const rows: Row[] = [auditHeadline(audit)];
	// Only the decision is persisted, so only the decision is ever claimed.
	for (const check of audit.checks) rows.push(checkRow(check));
	if (audit.phase === "running") {
		rows.push({ text: "Checks: not persisted", role: "dim" });
		rows.push({ text: "Decision: PENDING", role: "caution" });
		rows.push({ text: "no verdict yet", role: "dim" });
	}
	if (audit.phase === "approved") {
		rows.push({ text: "Decision: APPROVED", role: "success" });
		rows.push({ text: "Goal complete", role: "success" });
	}
	if (audit.phase === "disapproved") {
		rows.push({ text: "Decision: CHANGES REQUESTED", role: "error" });
		for (const finding of audit.findings) rows.push({ text: `- ${cut(finding)}`, role: "warning" });
		rows.push({ text: "Goal remains open", role: "muted" });
	}
	if (audit.phase === "error") {
		rows.push({ text: "Decision: ERROR", role: "error" });
		rows.push({ text: cut(audit.findings[0] ?? "Auditor could not finish"), role: "dim" });
	}
	if (audit.phase === "skipped") {
		rows.push({ text: "Decision: SKIPPED", role: "dim" });
		rows.push({ text: `Reason: ${cut(audit.reason ?? "not recorded", 30)}`, role: "dim" });
	}
	return rows;
}

/**
 * Builds the Goal X panel contribution for the current view.
 *
 * Priority order (matching the mission): status, objective, progress, current task,
 * upcoming tasks, completed tasks, then audit detail. Rows are capped at Atelier's
 * 24-row contribution limit.
 */
export function buildGoalXPanel(view: GoalXView): SidebarPanelContribution {
	const rows: Row[] = [statusRow(view)];
	const goal = view.goal;

	if (view.focused && goal) {
		rows.push({ text: cut(goal.objective), role: "primary" });
		const { completed, total, percentage } = view.progress;
		if (total > 0) {
			rows.push({ text: `Progress  ${completed}/${total} · ${percentage}%`, role: "muted" });
			rows.push({ text: meter(percentage), role: percentage >= 100 ? "success" : "output" });
		} else {
			rows.push({ text: "No task list", role: "dim" });
		}
		if (goal.status === "blocked" && goal.pauseReason)
			rows.push({ text: `Blocker: ${cut(goal.pauseReason, 40)}`, role: "error" });
		else if (goal.status === "paused" && goal.pauseReason)
			rows.push({ text: `Paused: ${cut(goal.pauseReason, 40)}`, role: "warning" });

		const current = view.currentTask;
		if (current) {
			const prefix = current.inferred ? "~" : "▶";
			const role: SidebarPanelRole = current.inferred ? "caution" : "working";
			rows.push({ text: `${prefix} ${cut(current.id, 10)} ${cut(current.title, 30)}`, role });
			if (current.inferred) rows.push({ text: "  inferred focus", role: "dim" });
			if (current.totalSubtasks > 0)
				rows.push({
					text: `  subtasks ${current.completedSubtasks}/${current.totalSubtasks}`,
					role: "muted",
				});
			const parent = flatten(goal.tasks).find((entry) => entry.task.id === current.id)?.task;
			const nextSubtask = parent?.subtasks?.find((task) => task.status === "pending");
			if (nextSubtask) rows.push({ text: `  ▸ ${cut(nextSubtask.title, 28)}`, role: "dim" });
		}

		const flat = flatten(goal.tasks);
		const upcoming = flat
			.filter((entry) => entry.task.status === "pending" && entry.task.id !== current?.id)
			.slice(0, 3);
		for (const { task, depth } of upcoming)
			rows.push({ text: `${"  ".repeat(depth)}${taskMark(task)} ${cut(task.title, 30)}`, role: "muted" });

		const settled = flat.filter((entry) => entry.task.status !== "pending");
		if (settled.length > 0) {
			const shown = settled.slice(-3);
			const hidden = settled.length - shown.length;
			rows.push({
				text: `${MARK.complete} ${settled.length} done${hidden > 0 ? ` · ${hidden} hidden` : ""}`,
				role: "success",
			});
			for (const { task } of shown)
				rows.push({
					text: `  ${taskMark(task)} ${cut(task.title, 30)}`,
					role: task.status === "complete" ? "success" : "dim",
				});
		}
	} else if (view.focused) {
		rows.push({ text: "archived or moved", role: "dim" });
		rows.push({ text: "not in this goal root", role: "dim" });
	} else if (view.available) {
		if (view.unfocusedOpen > 0)
			rows.push({ text: `${view.unfocusedOpen} open · not focused`, role: "muted" });
		rows.push({ text: "/goal-focus to select", role: "dim" });
	}

	rows.push(...auditRows(view.audit));

	return {
		id: GOALX_PANEL_ID,
		title: GOALX_PANEL_TITLE,
		role: "accent",
		rows: rows.slice(0, 24).map((row) => ({ text: row.text, role: row.role })),
	};
}
