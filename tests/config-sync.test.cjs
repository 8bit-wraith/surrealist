// Run with Node.js 24+: node --test tests/config-sync.test.cjs
// Focused, dependency-free harness: execute the actual synchronization function
// with only its imported adapters/stores mocked. No real config or UI is used.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { stripTypeScriptTypes } = require("node:module");

function harness(emit) {
	const source = fs.readFileSync(path.join(__dirname, "../src/util/config.tsx"), "utf8");
	const start = source.indexOf("let skipConfigSave = false;");
	const end = source.indexOf("export interface ConfigBackupOptions", start);
	assert.ok(start >= 0 && end > start, "source synchronization boundaries exist");
	const code = stripTypeScriptTypes(source.slice(start, end).replaceAll("export ", ""));
	let listener;
	const saves = [];
	class DesktopAdapter {}
	const adapter = Object.assign(new DesktopAdapter(), {
		loadConfig: async () => ({ configVersion: 1 }),
		processConfig: async (value) => value,
		saveConfig: (value) => saves.push(value),
		pruneQueryFiles() {},
	});
	const context = vm.createContext({
		adapter,
		DesktopAdapter,
		useConfigStore: {
			getState: () => ({}),
			setState() {},
			subscribe: (fn) => {
				listener = fn;
			},
		},
		isEmpty: (value) => Object.keys(value).length === 0,
		createBaseConfig: () => ({ configVersion: 1 }),
		applyMigrations: (value) => value,
		assign: Object.assign,
		CONFIG_VERSION: 1,
		debounce: (_, fn) => fn,
		getCurrentWindow: () => ({ emit }),
		setTimeout: () => {
			throw new Error("Unexpected incompatible config");
		},
		showDowngradeWarningModal() {},
	});
	vm.runInContext(code, context);
	return { start: () => context.startConfigSync(), update: (value) => listener(value), saves };
}

test("a failed broadcast does not disable later configuration saves", async () => {
	let calls = 0;
	const h = harness(async () => {
		if (++calls === 1) throw new Error("window unavailable");
	});
	await h.start();
	await assert.rejects(h.update({ revision: 1 }), /window unavailable/);
	await h.update({ revision: 2 });
	assert.equal(h.saves.length, 2);
	assert.equal(calls, 2);
});

test("broadcast echo is suppressed and subsequent edits resume after success", async () => {
	let release;
	const h = harness(
		() =>
			new Promise((resolve) => {
				release = resolve;
			}),
	);
	await h.start();
	const first = h.update({ revision: 1 });
	await h.update({ revision: "echo" });
	assert.equal(h.saves.length, 1);
	release();
	await first;
	const second = h.update({ revision: 2 });
	assert.equal(h.saves.length, 2);
	release();
	await second;
});

test("a synchronous broadcast failure also releases save suppression", async () => {
	let calls = 0;
	const h = harness(() => {
		if (++calls === 1) throw new Error("window closed");
		return Promise.resolve();
	});
	await h.start();
	await assert.rejects(h.update({ revision: 1 }), /window closed/);
	await h.update({ revision: 2 });
	assert.equal(h.saves.length, 2);
});
