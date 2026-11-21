import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { addLesson } from "../plugins/repo-lessons/.agents/lessons/store.ts";

const repo = realpathSync(mkdtempSync(join(tmpdir(), "repo-lessons-settings-")));
after(() => rmSync(repo, { force: true, recursive: true }));
execFileSync("git", ["init", "--quiet"], { cwd: repo });

for (const topic of ["build", "review", "deploy", "debug", "test", "rollback"]) {
	addLesson(repo, {
		version: 1,
		date: "2026-11-21",
		rule: `When updating the cache key, document the ${topic} procedure.`,
		tags: ["cache"],
		supersedes: [],
	});
}

const cli = fileURLToPath(
	new URL("../plugins/repo-lessons/.agents/lessons/cli.ts", import.meta.url),
);
const configPath = join(repo, "config.json");

function submit(config?: string, prompt = "updating the cache key") {
	if (config === undefined) rmSync(configPath, { force: true });
	else writeFileSync(configPath, config);
	const result = spawnSync(process.execPath, [cli, "prompt-hook"], {
		cwd: repo,
		encoding: "utf8",
		env: { ...process.env, REPO_LESSONS_CONFIG: configPath },
		input: JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: repo, prompt }),
	});
	assert.equal(result.status, 0, result.stderr);
	const output = JSON.parse(result.stdout) as {
		hookSpecificOutput?: { additionalContext: string };
	};
	return {
		count: output.hookSpecificOutput?.additionalContext
			.split("\n")
			.filter((line) => line.startsWith("- ")).length ?? 0,
		stderr: result.stderr,
	};
}

test("uses the default limit with no configuration file", () => {
	assert.equal(submit().count, 5);
});

test("applies a custom limit and supplies defaults for omitted settings", () => {
	assert.equal(submit('{"limit": 2}').count, 2);
	assert.equal(submit('{"limit": 10}').count, 6);
});

test("filters matches with a stricter similarity floor", () => {
	assert.equal(submit('{"minSimilarity": 0.99}').count, 0);
});

test("a zero threshold still ignores prompts without any searchable features", () => {
	assert.equal(submit('{"minSimilarity": 0}', "🪐").count, 0);
});

test("falls back to both defaults if settings cannot be parsed or validated", () => {
	for (const config of ["{", '{"limit": 0}', '{"minSimilarity": 2, "limit": 2}']) {
		const result = submit(config);
		assert.equal(result.count, 5);
		assert.match(result.stderr, /invalid or unreadable config/);
	}
});
