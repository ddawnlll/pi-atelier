export const GUARD_MARKER: string;
export const GUARDED: string;
export const UNGUARDED: string;
export const BACKUP_SUFFIX: string;
export interface PatchResult {
	changed: boolean;
	source: string;
	guardedSites: number;
	error?: string;
}
export function patchGoalStateSource(source: string): PatchResult;
export function revertGoalStateSource(source: string): PatchResult;
export function resolveGoalXRoot(explicit?: string): string;
export function goalXVersion(root: string): string;
export function assertSupported(version: string): void;
