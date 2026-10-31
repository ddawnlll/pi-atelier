/**
 * Preload shim for the opt-in benchmarks on Windows.
 *
 * `scripts/lib/source-sandbox.mjs` links `node_modules` into a temp sandbox with a real directory
 * symlink, which Windows denies with EPERM unless Developer Mode or elevation is enabled. This
 * shim keeps the upstream harness untouched and substitutes a junction only when that happens:
 *
 *   npm run bench:sidebar:win
 *   NODE_OPTIONS="--import=./scripts/win-symlink-shim.mjs" npm run bench:sidebar
 *
 * It is inert on every other platform and for paths npm creates itself.
 */
import fs from "node:fs";

const original = fs.symlinkSync;
fs.symlinkSync = (target, path, type) => {
	try {
		return original(target, path, type);
	} catch (error) {
		if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
		return original(target, path, "junction");
	}
};
