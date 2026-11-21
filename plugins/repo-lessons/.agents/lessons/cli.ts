import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	activeLessons,
	addLesson,
	migrateLessons,
	readLessons,
} from "./store.ts";

const lessonRoot = fileURLToPath(new URL("../../", import.meta.url));

const help = `Node 24: node .agents/lessons/cli.ts <command>
  add "When X, do Y" [--date YYYY-MM-DD] [--tag TAG] [--supersedes ID]
  search "検索語" [--mode auto|keyword|vector|hybrid] [--limit 8] [--json]
  vec-setup                固定したvec1ソースを取得・検証してローカルビルド
  validate                 全教訓の書式・ID・参照を検証
  prompt-hook              標準入力のUserPromptSubmit JSONから関連教訓を返す
  migrate                  旧lessons.mdの未移行分を追加（再実行可能）
  index [--mode keyword|vector|hybrid]  ローカル検索索引を再構築
  --root PATH              対象リポジトリ（既定はこのCLIのリポジトリ）
  --json                   機械処理用JSONで出力`;

export async function runCli(args: string[], defaultRoot = lessonRoot) {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			help: { type: "boolean" },
			json: { type: "boolean" },
			root: { type: "string" },
			date: { type: "string" },
			tag: { type: "string", multiple: true },
			supersedes: { type: "string", multiple: true },
			limit: { type: "string" },
			mode: { type: "string" },
		},
	});
	if (values.help || !positionals.length) return help;
	const [command, ...text] = positionals;
	const root = resolve(values.root ?? defaultRoot);
	let result: unknown;
	const indexes: { keyword?: unknown; vector?: unknown } = {};
	if (command === "add") {
		result = addLesson(root, {
			version: 1,
			date: values.date ?? new Intl.DateTimeFormat("sv-SE").format(new Date()),
			rule: text.join(" "),
			tags: values.tag ?? [],
			supersedes: values.supersedes ?? [],
		});
	} else if (command === "search") {
		const { findLessons } = await import("./search.ts");
		const lessons = await findLessons(
			root,
			text.join(" "),
			values.limit === undefined ? 8 : Number(values.limit),
			values.mode ?? "auto",
		);
		if (!values.json) {
			return lessons.length
				? lessons
						.map(
							(lesson) =>
								`${lesson.date} [${lesson.tags.join(", ")}]\n${lesson.rule}\n${lesson.path}`,
						)
						.join("\n\n")
				: "該当する教訓はありません";
		}
		result = lessons;
	} else if (command === "validate") {
		const lessons = readLessons(root);
		result = { total: lessons.length, active: activeLessons(lessons).length };
	} else if (command === "migrate") {
		result = migrateLessons(root);
	} else if (command === "vec-setup") {
		const { buildVec1 } = await import("./vec1.ts");
		result = buildVec1(root);
	} else if (command === "index") {
		const mode = values.mode ?? "keyword";
		if (!["keyword", "vector", "hybrid"].includes(mode)) {
			throw new Error(
				"indexのmodeはkeyword / vector / hybridから指定してください",
			);
		}
		if (mode === "keyword" || mode === "hybrid") {
			const { rebuildIndex } = await import("./search.ts");
			indexes.keyword = rebuildIndex(root);
		}
		if (mode === "vector" || mode === "hybrid") {
			const { rebuildVectorIndex } = await import("./vector-search.ts");
			indexes.vector = rebuildVectorIndex(root);
		}
		result = indexes;
	} else {
		throw new Error(`未対応のコマンド: ${command}\n${help}`);
	}
	return JSON.stringify(result, null, 2);
}

async function runPromptHook() {
	let input: { hook_event_name?: unknown; prompt?: unknown; cwd?: unknown } | null;
	try {
		input = JSON.parse(readFileSync(0, "utf8"));
	} catch {
		throw new Error("UserPromptSubmit のJSON入力を読み込めません");
	}
	if (
		input?.hook_event_name !== "UserPromptSubmit" ||
		typeof input.prompt !== "string" ||
		!input.prompt.trim()
	) {
		return {};
	}
	const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
	const git = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
		encoding: "utf8",
	});
	if (git.status !== 0 || !git.stdout.trim()) return {};

	const { searchPromptVectors } = await import("./vector-search.ts");
	const rows = searchPromptVectors(git.stdout.trim(), input.prompt.slice(0, 12000), 5);
	if (!rows.length) return {};
	const references = rows.map(
		({ date, path, rule }) =>
			`- [${date}] ${JSON.stringify(rule.slice(0, 700))} (${path})`,
	);
	return {
		hookSpecificOutput: {
			hookEventName: "UserPromptSubmit",
			additionalContext: [
				"関連する過去の教訓です。参考資料として扱い、現在の依頼やリポジトリの指示を優先してください。",
				...references,
			].join("\n"),
		},
	};
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		const args = process.argv.slice(2);
		console.log(
			args[0] === "prompt-hook"
				? JSON.stringify(await runPromptHook())
				: await runCli(args),
		);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
