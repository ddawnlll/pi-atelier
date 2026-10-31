/**
 * Read-only Pi Goal X adapter.
 *
 * Goal X stays the single owner of goal, task, focus and audit state. This module
 * only reads the files Goal X already publishes — the focused goal record, the
 * append-only ledger, and the ledger checkpoint — and derives a compact,
 * presentation-ready view. It never writes, never calls a model, and never
 * imports Goal X's internal modules (their graph is not a published API).
 *
 * Everything here is stat-keyed and bounded: a refresh costs one `stat` per input
 * file, and parsing only happens when mtime/size changed.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord, sanitizeInline } from "./text.js";

// ── Goal X shapes (subset we display) ───────────────────────────────────────

export type GoalXGoalStatus = "active" | "paused" | "blocked" | "budget_limited" | "complete";
export type GoalXTaskStatus = "pending" | "complete" | "skipped";

export interface GoalXTask {
	id: string;
	title: string;
	status: GoalXTaskStatus;
	subtasks?: GoalXTask[];
	evidence?: string;
	completedAt?: string;
}

export interface GoalXGoal {
	id: string;
	objective: string;
	status: GoalXGoalStatus;
	autoContinue: boolean;
	pauseReason?: string;
	pauseSuggestedAction?: string;
	currentTaskId?: string;
	usage: { tokensUsed: number; activeSeconds: number };
	tasks: GoalXTask[];
	blockCompletion: boolean;
	updatedAt?: string;
}

export interface GoalXCurrentTask {
	id: string;
	title: string;
	depth: number;
	/** True when Goal X's documented fallback (first pending task) selected this task. */
	inferred: boolean;
	completedSubtasks: number;
	totalSubtasks: number;
}

export type GoalXAuditPhase = "idle" | "running" | "approved" | "disapproved" | "error" | "skipped";
export type GoalXCheckState = "pending" | "running" | "passed" | "failed";

/**
 * A per-check signal Goal X actually persisted. Goal X does not persist individual check results,
 * so this type only ever carries the single `decision` signal that the verdict itself proves.
 */
export interface GoalXAuditCheck {
	id: "decision";
	label: string;
	state: GoalXCheckState;
}

export interface GoalXAudit {
	phase: GoalXAuditPhase;
	/** False: Goal X persists no per-check results. The panel says so instead of guessing. */
	checksKnown: boolean;
	checks: GoalXAuditCheck[];
	/** Explicit decision record; absent means no verdict exists yet. */
	decision?: "pending" | "approved" | "changes_requested" | "error" | "skipped";
	verdict?: "approved" | "disapproved" | "error";
	report?: string;
	findings: string[];
	at?: string;
	reason?: string;
	auditorLabel?: string;
}

export interface GoalXView {
	/** A Goal X storage root was found. */
	available: boolean;
	/** A goal is focused for this session (session focus, never the pool). */
	focused: boolean;
	openGoalCount: number;
	goal?: GoalXGoal;
	currentTask?: GoalXCurrentTask;
	progress: { completed: number; total: number; percentage: number };
	audit: GoalXAudit;
	/** True when a goal exists in the pool but this session is explicitly unfocused. */
	unfocusedOpen: number;
	/**
	 * The session focused an id that has no active goal record: Goal X archived it, another process
	 * moved it, or the root changed. Never silently keeps showing a stale goal.
	 */
	recordMissing?: boolean;
	storageRoot: string;
	/** Resolved record path for the focused goal; internal detail used to detect record edits. */
	goalFile?: string;
	warnings: string[];
}

/** Session focus, read from Goal X's `pi-goal-focus` session entries. */
export interface GoalXFocus {
	focusedGoalId: string | null;
	/** Goal X records the storage root alongside focus when it differs from the default. */
	storageRoot?: string;
}

export interface GoalXViewOptions {
	cwd: string;
	/**
	 * Focus for THIS session. Never derived from the project pool: a goal another session focused,
	 * or a goal that merely exists, must not become this session's focus.
	 */
	focus?: GoalXFocus;
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	/** Cap on ledger bytes read from the tail (default 512 KiB). */
	maxLedgerBytes?: number;
}

const EMPTY_AUDIT: GoalXAudit = { phase: "idle", checksKnown: false, checks: [], findings: [] };

/** The only per-check signal the ledger can prove: the final decision itself. */
const DECISION_LABEL = "Final decision";

// ── Storage root resolution ─────────────────────────────────────────────────

const isEnoent = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

function expandHome(value: string, homeDir: string): string {
	if (value === "~") return homeDir;
	if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(homeDir, value.slice(2));
	return value;
}

function readGoalsRootSetting(file: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!isRecord(parsed)) return undefined;
		const value = parsed.goalsRoot;
		return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolves the Goal X goal root the same way `storage/goal-root.ts` does:
 * env override, then the project layer, then the global layer, then `<cwd>/.pi/goals`.
 */
export function resolveGoalXRoot(options: GoalXViewOptions): string {
	const cwd = options.cwd;
	const env = options.env ?? process.env;
	const homeDir = options.homeDir ?? os.homedir();
	const agentDir = env.PI_CODING_AGENT_DIR?.trim()
		? path.resolve(cwd, expandHome(env.PI_CODING_AGENT_DIR.trim(), homeDir))
		: path.join(homeDir, ".pi", "agent");
	const sessionRoot = options.focus?.storageRoot?.trim();
	if (sessionRoot) {
		const expanded = expandHome(sessionRoot, homeDir);
		if (path.isAbsolute(expanded) && !expanded.includes("\0")) return path.normalize(expanded);
	}
	const override = env.PI_GOAL_ROOT?.trim();
	const configured =
		(override ? expandHome(override, homeDir) : undefined) ??
		readGoalsRootSetting(path.join(cwd, ".pi", "pi-goal-x-settings.json")) ??
		readGoalsRootSetting(path.join(agentDir, "pi-goal-x-settings.json"));
	if (configured) {
		const expanded = expandHome(configured, homeDir);
		if (path.isAbsolute(expanded) && !expanded.includes("\0")) return path.normalize(expanded);
	}
	return path.resolve(cwd, ".pi", "goals");
}

// ── Small bounded file helpers ──────────────────────────────────────────────

interface FileStamp {
	mtimeMs: number;
	size: number;
}

function stamp(file: string): FileStamp | undefined {
	try {
		const stat = fs.statSync(file);
		return stat.isFile() ? { mtimeMs: stat.mtimeMs, size: stat.size } : undefined;
	} catch {
		return undefined;
	}
}

function sameStamp(left: FileStamp | undefined, right: FileStamp | undefined): boolean {
	return left?.mtimeMs === right?.mtimeMs && left?.size === right?.size;
}

/** Reads at most `maxBytes` from the end of a file; drops a partial leading line. */
function readTail(file: string, maxBytes: number): string | undefined {
	try {
		const size = fs.statSync(file).size;
		const start = Math.max(0, size - maxBytes);
		const length = size - start;
		if (length <= 0) return "";
		const buffer = Buffer.allocUnsafe(length);
		const fd = fs.openSync(file, "r");
		try {
			fs.readSync(fd, buffer, 0, length, start);
		} finally {
			fs.closeSync(fd);
		}
		const text = buffer.toString("utf8");
		return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
	} catch {
		return undefined;
	}
}

/** Finds the end of the leading balanced JSON object, tolerating braces inside strings. */
export function findJsonObjectEnd(content: string): number {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < content.length; index += 1) {
		const char = content[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) return index + 1;
		}
	}
	return -1;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function parseTask(value: unknown): GoalXTask | undefined {
	if (!isRecord(value)) return undefined;
	const id = asString(value.id);
	const title = asString(value.title);
	if (!id || !title) return undefined;
	const status: GoalXTaskStatus =
		value.status === "complete" || value.status === "skipped" || value.status === "pending"
			? value.status
			: "pending";
	const subtasks = Array.isArray(value.subtasks)
		? value.subtasks.map(parseTask).filter((task): task is GoalXTask => task !== undefined)
		: undefined;
	return {
		id,
		title,
		status,
		...(subtasks && subtasks.length > 0 ? { subtasks } : {}),
		...(asString(value.evidence) ? { evidence: value.evidence as string } : {}),
		...(asString(value.completedAt) ? { completedAt: value.completedAt as string } : {}),
	};
}

/** Parses a Goal X goal file (`<json>\n<body>`), returning null for anything unusable. */
export function parseGoalXRecord(content: string): GoalXGoal | undefined {
	const end = findJsonObjectEnd(content);
	if (end <= 0) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(content.slice(0, end));
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	const id = asString(parsed.id);
	const objective = asString(parsed.objective);
	if (!id || !objective) return undefined;
	const status: GoalXGoalStatus =
		(["active", "paused", "blocked", "budget_limited", "complete"] as const).find(
			(candidate) => candidate === parsed.status,
		) ?? "active";
	const taskList = isRecord(parsed.taskList) ? parsed.taskList : undefined;
	const tasks = Array.isArray(taskList?.tasks)
		? taskList.tasks.map(parseTask).filter((task): task is GoalXTask => task !== undefined)
		: [];
	const usage = isRecord(parsed.usage) ? parsed.usage : {};
	return {
		id,
		objective,
		status,
		autoContinue: parsed.autoContinue === true,
		...(asString(parsed.pauseReason) ? { pauseReason: parsed.pauseReason as string } : {}),
		...(asString(parsed.pauseSuggestedAction)
			? { pauseSuggestedAction: parsed.pauseSuggestedAction as string }
			: {}),
		...(asString(parsed.currentTaskId) ? { currentTaskId: parsed.currentTaskId as string } : {}),
		usage: {
			tokensUsed: typeof usage.tokensUsed === "number" && usage.tokensUsed >= 0 ? usage.tokensUsed : 0,
			activeSeconds:
				typeof usage.activeSeconds === "number" && usage.activeSeconds >= 0 ? usage.activeSeconds : 0,
		},
		tasks,
		blockCompletion: taskList?.blockCompletion === true,
		...(asString(parsed.updatedAt) ? { updatedAt: parsed.updatedAt as string } : {}),
	};
}

// ── Task tree helpers (mirror Goal X's documented semantics) ────────────────

interface FlatTask {
	task: GoalXTask;
	depth: number;
}

export function flattenGoalXTasks(tasks: readonly GoalXTask[], depth = 0): FlatTask[] {
	const flat: FlatTask[] = [];
	for (const task of tasks) {
		flat.push({ task, depth });
		if (task.subtasks && task.subtasks.length > 0) flat.push(...flattenGoalXTasks(task.subtasks, depth + 1));
	}
	return flat;
}

const isSettled = (task: GoalXTask): boolean => task.status === "complete" || task.status === "skipped";

/**
 * Goal X's `deriveCurrentTask`: accept `currentTaskId` only when it points at an
 * existing pending task, otherwise fall back to the first pending task in tree
 * order and mark it inferred. Never invented beyond that documented fallback.
 */
export function deriveGoalXCurrentTask(goal: GoalXGoal): GoalXCurrentTask | undefined {
	const flat = flattenGoalXTasks(goal.tasks);
	const pending = flat.filter((entry) => entry.task.status === "pending");
	if (pending.length === 0) return undefined;
	const explicit = goal.currentTaskId
		? pending.find((entry) => entry.task.id === goal.currentTaskId)
		: undefined;
	const selected = explicit ?? pending[0];
	if (!selected) return undefined;
	const subtasks = selected.task.subtasks ?? [];
	return {
		id: selected.task.id,
		title: selected.task.title,
		depth: selected.depth,
		inferred: explicit === undefined,
		completedSubtasks: subtasks.filter(isSettled).length,
		totalSubtasks: subtasks.length,
	};
}

/** Top-level completion, matching Goal X's `deriveTopLevelTaskProgress`. */
export function deriveGoalXProgress(goal: GoalXGoal): {
	completed: number;
	total: number;
	percentage: number;
} {
	const total = goal.tasks.length;
	const completed = goal.tasks.filter(isSettled).length;
	return { completed, total, percentage: total === 0 ? 0 : Math.round((completed / total) * 100) };
}

// ── Ledger ──────────────────────────────────────────────────────────────────

export interface GoalXLedgerEvent {
	type: string;
	goalId?: string;
	[key: string]: unknown;
}

export interface GoalXLedger {
	events: GoalXLedgerEvent[];
	malformed: number;
	focusedGoalId: string | null;
}

function parseLedger(text: string): { events: GoalXLedgerEvent[]; malformed: number } {
	const events: GoalXLedgerEvent[] = [];
	let malformed = 0;
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			malformed += 1;
			continue;
		}
		if (!isRecord(parsed) || typeof parsed.type !== "string") {
			malformed += 1;
			continue;
		}
		events.push(parsed as GoalXLedgerEvent);
	}
	return { events, malformed };
}

/** Entry `customType` Goal X writes when focus changes (goal-format.ts `FOCUS_ENTRY`). */
export const GOALX_FOCUS_ENTRY = "pi-goal-focus";

interface SessionEntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
}

/**
 * Reads the session's most recent Goal X focus entry. This is the only authoritative source of
 * per-session focus: Goal X records focus in the session transcript, not in the project ledger.
 * An explicit unfocus entry (`focusedGoalId: null`) is honoured and never overridden.
 *
 * Later entries win; malformed entries are ignored rather than guessed at.
 */
export function readSessionGoalXFocus(entries: readonly unknown[]): GoalXFocus | undefined {
	let focus: GoalXFocus | undefined;
	for (const raw of entries) {
		if (!isRecord(raw)) continue;
		const entry = raw as SessionEntryLike;
		if (entry.type !== "custom" || entry.customType !== GOALX_FOCUS_ENTRY) continue;
		const data = entry.data;
		if (!isRecord(data)) continue;
		const id = data.focusedGoalId;
		if (id === null) {
			focus = { focusedGoalId: null };
			continue;
		}
		if (typeof id !== "string" || id === "") continue;
		const root =
			typeof data.storageRoot === "string" && data.storageRoot !== "" ? data.storageRoot : undefined;
		focus = root ? { focusedGoalId: id, storageRoot: root } : { focusedGoalId: id };
	}
	return focus;
}

function findLastAuditEvent(
	events: readonly GoalXLedgerEvent[],
	goalId: string,
): GoalXLedgerEvent | undefined {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (!event || event.goalId !== goalId) continue;
		if (event.type === "audit_result" || event.type === "audit_started" || event.type === "audit_skipped")
			return event;
	}
	return undefined;
}

/**
 * Goal X persists only `audit_result{verdict,report}`. The single decision check is therefore the
 * only check that can be reported; naming the other stages would claim results that were never
 * recorded.
 */
function decisionCheck(verdict: "approved" | "disapproved" | "error"): GoalXAuditCheck[] {
	return [
		{
			id: "decision",
			label: DECISION_LABEL,
			state: verdict === "approved" ? "passed" : "failed",
		},
	];
}

/** Extracts up to three concrete findings from an auditor report, deterministically. */
export function extractGoalXFindings(report: string): string[] {
	const findings: string[] = [];
	for (const raw of report.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		if (/^<(approved|disapproved)\s*\/>/.test(line)) continue;
		const cleaned = line
			.replace(/^[-*•✗✓]\s*/, "")
			.replace(/^(\d+[.)])\s*/, "")
			.trim();
		if (!cleaned) continue;
		if (/^auditor\s*:/i.test(cleaned)) continue;
		if (/^[a-z][a-z ]{0,24}:$/i.test(cleaned)) continue;
		findings.push(cleaned.length > 200 ? `${cleaned.slice(0, 197)}...` : cleaned);
		if (findings.length >= 3) break;
	}
	return findings;
}

/** Derives the audit state from the ledger only — no live auditor access exists here. */
export function deriveGoalXAudit(events: readonly GoalXLedgerEvent[], goalId: string): GoalXAudit {
	const latest = findLastAuditEvent(events, goalId);
	if (!latest) return { ...EMPTY_AUDIT, checks: [] };
	if (latest.type === "audit_started") {
		// Goal X reports start and (much later) the verdict; nothing in between is persisted.
		return {
			phase: "running",
			checksKnown: false,
			checks: [],
			decision: "pending",
			findings: [],
			...(typeof latest.at === "string" ? { at: latest.at } : {}),
		};
	}
	if (latest.type === "audit_skipped") {
		return {
			phase: "skipped",
			checksKnown: false,
			checks: [],
			decision: "skipped",
			findings: [],
			...(typeof latest.reason === "string" ? { reason: latest.reason } : {}),
			...(typeof latest.at === "string" ? { at: latest.at } : {}),
		};
	}
	const verdict =
		latest.verdict === "approved" || latest.verdict === "disapproved" || latest.verdict === "error"
			? latest.verdict
			: "error";
	const report = typeof latest.report === "string" ? latest.report : "";
	return {
		phase: verdict,
		checksKnown: true,
		checks: decisionCheck(verdict),
		decision: verdict === "approved" ? "approved" : verdict === "disapproved" ? "changes_requested" : "error",
		verdict,
		...(report ? { report } : {}),
		findings: verdict === "approved" ? [] : extractGoalXFindings(report),
		...(typeof latest.at === "string" ? { at: latest.at } : {}),
	};
}

function countOpenGoals(root: string): number {
	let entries: string[];
	try {
		entries = fs.readdirSync(root);
	} catch {
		return 0;
	}
	let count = 0;
	for (const name of entries) {
		if (!/^active_goal_.*\.md$/.test(name)) continue;
		// Listing is enough for a count; a corrupt file only miscounts by one.
		count += 1;
	}
	return count;
}

// ── Reader ──────────────────────────────────────────────────────────────────

export interface GoalXReader {
	/** Current memoized view; performs at most one stat round when stale. */
	view(): GoalXView;
	/** Forces a re-read on the next `view()`. */
	invalidate(): void;
	dispose(): void;
}

export interface GoalXReaderOptions extends GoalXViewOptions {
	/**
	 * Current session focus. Read on every `view()` so a focus change (a new
	 * `pi-goal-focus` entry) is picked up even though it touches no file on disk.
	 */
	getFocus?: () => GoalXFocus | undefined;
	/** Called after a watched change is observed (already debounced). */
	onChange?: () => void;
	/** Disable the directory watcher (tests, headless callers). */
	watch?: boolean;
	now?: () => number;
}

const WATCH_DEBOUNCE_MS = 120;

/** Parses every active goal file, keeping only the focused record when known. */
function loadFocusedGoal(
	root: string,
	focusedId: string | null,
): { goal?: GoalXGoal; file?: string; warnings: string[] } {
	const warnings: string[] = [];
	if (!focusedId) return { warnings };
	let entries: string[];
	try {
		entries = fs.readdirSync(root);
	} catch (error) {
		if (!isEnoent(error)) warnings.push("Goal X storage is unreadable.");
		return { warnings };
	}
	const candidates = entries.filter((name) => /^active_goal_.*\.md$/.test(name));
	for (const name of candidates) {
		const file = path.join(root, name);
		let content: string;
		try {
			content = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const goal = parseGoalXRecord(content);
		if (goal?.id === focusedId) return { goal, file, warnings };
	}
	return { warnings };
}

export function readGoalXView(options: GoalXViewOptions): GoalXView {
	const root = resolveGoalXRoot(options);
	const warnings: string[] = [];
	const focusedId = options.focus?.focusedGoalId ?? null;
	const ledgerPath = path.join(root, "goal_events.jsonl");
	const ledgerText = readTail(ledgerPath, options.maxLedgerBytes ?? 512 * 1024);
	const openGoalCount = countOpenGoals(root);
	const base: GoalXView = {
		available: ledgerText !== undefined || fs.existsSync(root),
		focused: focusedId !== null,
		openGoalCount,
		progress: { completed: 0, total: 0, percentage: 0 },
		audit: EMPTY_AUDIT,
		unfocusedOpen: focusedId === null ? openGoalCount : Math.max(0, openGoalCount - 1),
		storageRoot: root,
		warnings,
	};
	// A missing ledger only means no audit history yet; the focused goal record is still readable.
	const parsed = ledgerText === undefined ? { events: [], malformed: 0 } : parseLedger(ledgerText);
	const { events, malformed } = parsed;
	if (malformed > 0)
		warnings.push(`${malformed} malformed ledger line${malformed === 1 ? "" : "s"} ignored.`);
	if (!focusedId) return base;
	const loaded = loadFocusedGoal(root, focusedId);
	warnings.push(...loaded.warnings);
	const goal = loaded.goal;
	if (!goal) {
		// Focused id without a matching record: Goal X is mid-write, archived it, or the root differs.
		return { ...base, recordMissing: true };
	}
	const currentTask = deriveGoalXCurrentTask(goal);
	return {
		...base,
		goal,
		...(loaded.file ? { goalFile: loaded.file } : {}),
		...(currentTask ? { currentTask } : {}),
		progress: deriveGoalXProgress(goal),
		audit: deriveGoalXAudit(events, goal.id),
	};
}

/**
 * Memoizing reader. `view()` re-stats the three inputs and re-parses only when a
 * stamp changed, so callers may invoke it from a render path without repeated I/O.
 */
export function createGoalXReader(options: GoalXReaderOptions): GoalXReader {
	let root = resolveGoalXRoot(options);
	const focusOf = (): GoalXFocus | undefined => options.getFocus?.() ?? options.focus;
	let ledgerPath = path.join(root, "goal_events.jsonl");
	let cached:
		| { view: GoalXView; stamp: FileStamp | undefined; focusKey: string; goalStamp: FileStamp | undefined }
		| undefined;
	/** Record path per focus id: resolved by suffix so a goal edit is detected without a rescan. */
	const goalPathByFocus = new Map<string, string>();
	let disposed = false;
	let watcher: fs.FSWatcher | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const read = (): GoalXView => {
		const focus = focusOf();
		const resolvedOptions: GoalXViewOptions = focus === undefined ? options : { ...options, focus };
		const nextRoot = resolveGoalXRoot(resolvedOptions);
		if (nextRoot !== root) {
			// A session may switch to an external goal root; re-target the watcher lazily.
			root = nextRoot;
			ledgerPath = path.join(root, "goal_events.jsonl");
			watch();
			cached = undefined;
		}
		const focusId = focus?.focusedGoalId ?? null;
		const goalPath = focusId ? resolveGoalPath(root, focusId) : undefined;
		const stampNow = stamp(ledgerPath);
		const focusKey = `${focusId ?? ""}|${focus?.storageRoot ?? ""}`;
		const goalStamp = goalPath ? stamp(goalPath) : undefined;
		if (
			cached &&
			sameStamp(cached.stamp, stampNow) &&
			cached.focusKey === focusKey &&
			sameStamp(cached.goalStamp, goalStamp)
		)
			return cached.view;
		const view = readGoalXView(resolvedOptions);
		cached = { view, stamp: stampNow, focusKey, goalStamp };
		return view;
	};

	/** Finds `active_goal_*_<id>.md` without parsing; the id suffix keeps it O(files). */
	function resolveGoalPath(cwdRoot: string, id: string): string | undefined {
		const known = goalPathByFocus.get(`${cwdRoot}|${id}`);
		if (known && stamp(known)) return known;
		let names: string[];
		try {
			names = fs.readdirSync(cwdRoot);
		} catch {
			return undefined;
		}
		const match = names.find((name) => name.endsWith(`_${id}.md`) && name.startsWith("active_goal_"));
		if (!match) {
			goalPathByFocus.delete(`${cwdRoot}|${id}`);
			return undefined;
		}
		const file = path.join(cwdRoot, match);
		goalPathByFocus.set(`${cwdRoot}|${id}`, file);
		return file;
	}

	function watch(): void {
		if (options.watch === false) return;
		try {
			watcher?.close();
		} catch {
			// A closed watcher is not an error worth surfacing.
		}
		watcher = undefined;
		try {
			watcher = fs.watch(root, { persistent: false }, () => {
				if (disposed) return;
				if (timer) clearTimeout(timer);
				timer = setTimeout(() => {
					timer = undefined;
					if (disposed) return;
					options.onChange?.();
				}, WATCH_DEBOUNCE_MS);
				// A pending timer must not keep the process alive.
				if (typeof (timer as { unref?: () => void }).unref === "function")
					(timer as { unref: () => void }).unref();
			});
			watcher.on("error", () => {
				try {
					watcher?.close();
				} catch {
					// Ignore close failures on an errored watcher.
				}
				watcher = undefined;
			});
		} catch {
			watcher = undefined;
		}
	}

	watch();

	return {
		view: () => (disposed ? { ...EMPTY_VIEW, storageRoot: root } : read()),
		invalidate: () => {
			cached = undefined;
		},
		dispose: () => {
			disposed = true;
			cached = undefined;
			if (timer) clearTimeout(timer);
			timer = undefined;
			try {
				watcher?.close();
			} catch {
				// Closing an already-closed watcher is not an error worth surfacing.
			}
			watcher = undefined;
		},
	};
}

const EMPTY_VIEW: GoalXView = {
	available: false,
	focused: false,
	openGoalCount: 0,
	progress: { completed: 0, total: 0, percentage: 0 },
	audit: EMPTY_AUDIT,
	unfocusedOpen: 0,
	storageRoot: "",
	warnings: [],
};

/** Sanitized one-line objective/title text for callers that render outside the panel. */
export const goalXDisplayText = (value: string | undefined, fallback = ""): string =>
	value === undefined ? fallback : sanitizeInline(value);
