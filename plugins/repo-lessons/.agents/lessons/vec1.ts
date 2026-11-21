import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Immutable revisions and checksums: do not download or build moving upstream HEAD.
export const vec1Revision = "a27bcfe21c9b4e0989e86eec8fb34a3832cd23c7";
const headerRevision = "cdc1b38d40cb567b7ad0b39c86addf830a0af0ae";
const sources = [
	{
		name: "vec1.c",
		url: `https://raw.githubusercontent.com/sqlite/sqlite/${vec1Revision}/ext/vec1/vec1.c`,
		sha256: "a38c62274093bec34631831371ad433703d6dde7fa9ecd6088da4ed33d4a61f9",
	},
	{
		name: "sqlite3.h",
		url: `https://raw.githubusercontent.com/nodejs/node/${headerRevision}/deps/sqlite/sqlite3.h`,
		sha256: "4ff81af4849acabc76fc8349abb926814395072617ca18e08800abf734ab7612",
	},
	{
		name: "sqlite3ext.h",
		url: `https://raw.githubusercontent.com/nodejs/node/${headerRevision}/deps/sqlite/sqlite3ext.h`,
		sha256: "ac9645e5c9ff0cf176efdd6e75cb5e98f46295d38e02db5c4d208826a39ab4be",
	},
];

const buildId = createHash("sha256")
	.update(JSON.stringify(sources) + "portable-O2-v1")
	.digest("hex")
	.slice(0, 16);

export function vec1Path(root: string) {
	const suffix =
		process.platform === "win32"
			? ".dll"
			: process.platform === "darwin"
				? ".dylib"
				: ".so";
	return join(
		root,
		".cache/lessons/vec1",
		buildId,
		`${process.platform}-${process.arch}`,
		`vec1${suffix}`,
	);
}

/** Loading native code is limited to the extension built from the pinned recipe. */
export function loadVec1(database: DatabaseSync, path: string): string {
	const version = database
		.prepare("SELECT sqlite_version() AS version")
		.get()?.version;
	const [major, minor, patch] = String(version).split(".").map(Number);
	if (major * 1_000_000 + minor * 1_000 + patch < 3_053_003) {
		throw new Error(
			"vec1にはSQLite 3.53.3以上を含むNode 24が必要です。Nodeを更新してください",
		);
	}
	if (!existsSync(path)) {
		throw new Error(
			"vec1が未構築です。node .agents/lessons/cli.ts vec-setup を実行してください",
		);
	}
	database.loadExtension(path);
	database.enableLoadExtension(false);
	return String(
		database.prepare("SELECT vec1_info() AS version").get()?.version,
	);
}

function inspectExtension(path: string) {
	const database = new DatabaseSync(":memory:", { allowExtension: true });
	try {
		return loadVec1(database, path);
	} finally {
		database.close();
	}
}

/** One explicit setup downloads verified sources, builds locally, then checks loading. */
export function buildVec1(root: string) {
	const path = vec1Path(root);
	if (existsSync(path))
		return { path, version: inspectExtension(path), built: false };
	if (!["linux", "darwin", "win32"].includes(process.platform)) {
		throw new Error(`vec1のビルドに未対応のOSです: ${process.platform}`);
	}
	const parent = dirname(path);
	mkdirSync(parent, { recursive: true });
	const directory = mkdtempSync(join(parent, "build-"));
	try {
		for (const source of sources) {
			const destination = join(directory, source.name);
			execFileSync(
				"curl",
				[
					"--fail",
					"--silent",
					"--show-error",
					"--location",
					"--max-time",
					"60",
					source.url,
					"--output",
					destination,
				],
				{ stdio: ["ignore", "pipe", "pipe"] },
			);
			const actual = createHash("sha256")
				.update(readFileSync(destination))
				.digest("hex");
			if (actual !== source.sha256)
				throw new Error(`${source.name}: チェックサムが一致しません`);
		}
		const binary = join(
			directory,
			process.platform === "win32"
				? "vec1.dll"
				: process.platform === "darwin"
					? "vec1.dylib"
					: "vec1.so",
		);
		if (process.platform === "win32") {
			execFileSync(
				"cl",
				["/LD", "/O2", "/DNDEBUG", "vec1.c", `/Fe:${binary}`],
				{
					cwd: directory,
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
		} else {
			execFileSync(
				"cc",
				[
					"-O2",
					"-DNDEBUG",
					process.platform === "darwin" ? "-dynamiclib" : "-shared",
					"-fPIC",
					"-I",
					directory,
					"vec1.c",
					"-o",
					binary,
					"-lm",
					"-pthread",
				],
				{ cwd: directory, stdio: ["ignore", "pipe", "pipe"] },
			);
		}
		const version = inspectExtension(binary);
		renameSync(binary, path);
		return { path, version, built: true };
	} catch (error) {
		const detail =
			error instanceof Error
				? (error as { stderr?: Buffer }).stderr?.toString().trim() ||
					error.message
				: String(error);
		throw new Error(
			`vec1の構築に失敗しました。curlとCコンパイラを確認してください: ${detail}`,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
