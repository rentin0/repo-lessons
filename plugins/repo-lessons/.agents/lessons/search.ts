import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { activeLessons, readLessons, type Lesson } from "./store.ts";

type SearchResult = Omit<Lesson, "supersedes"> & {
	rankScore?: number;
	matches?: string[];
	similarity?: number;
	model?: string;
};

export function indexPath(root: string) {
	return join(root, ".cache/lessons/index.sqlite");
}

function searchable(text: string) {
	return text.normalize("NFKC").toLowerCase();
}

/** SQLite is a disposable projection; a Git checkout invalidates it by content. */
function openIndex(root: string, force: boolean) {
	const lessons = activeLessons(readLessons(root));
	const fingerprint = createHash("sha256")
		.update(JSON.stringify(lessons))
		.digest("hex");
	mkdirSync(join(root, ".cache/lessons"), { recursive: true });
	const database = new DatabaseSync(indexPath(root));
	try {
		database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
		database.exec(`
			CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS lessons (
				id TEXT PRIMARY KEY, date TEXT NOT NULL, rule TEXT NOT NULL,
				tags TEXT NOT NULL, path TEXT NOT NULL
			);
			CREATE VIRTUAL TABLE IF NOT EXISTS lesson_search
				USING fts5(id UNINDEXED, rule, tags, tokenize='trigram');
		`);
		// The transaction also serializes concurrent searches rebuilding the same index.
		database.exec("BEGIN IMMEDIATE");
		try {
			const stored = database
				.prepare("SELECT value FROM metadata WHERE key = 'fingerprint'")
				.get();
			if (force || stored?.value !== fingerprint) {
				database.exec("DELETE FROM lessons; DELETE FROM lesson_search;");
				const insert = database.prepare(
					"INSERT INTO lessons VALUES (?, ?, ?, ?, ?)",
				);
				const insertSearch = database.prepare(
					"INSERT INTO lesson_search VALUES (?, ?, ?)",
				);
				for (const lesson of lessons) {
					insert.run(
						lesson.id,
						lesson.date,
						lesson.rule,
						JSON.stringify(lesson.tags),
						lesson.path,
					);
					insertSearch.run(
						lesson.id,
						searchable(lesson.rule),
						searchable(lesson.tags.join(" ")),
					);
				}
				database
					.prepare("INSERT OR REPLACE INTO metadata VALUES ('fingerprint', ?)")
					.run(fingerprint);
			}
			database.exec("COMMIT");
		} catch (error) {
			database.exec("ROLLBACK");
			throw error;
		}
		return { database, count: lessons.length };
	} catch (error) {
		database.close();
		throw error;
	}
}

export function rebuildIndex(root: string) {
	const { database, count } = openIndex(root, true);
	database.close();
	return { indexed: count, database: indexPath(root) };
}

/** Literal AND search: trigram covers Japanese; short words use substring matching. */
export function searchLessons(root: string, query: string, limit = 8) {
	const tokens = [
		...new Set(searchable(query).trim().split(/\s+/).filter(Boolean)),
	];
	if (!tokens.length) throw new Error("検索語を指定してください");
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
		throw new Error("limitは1〜100の整数にしてください");
	}
	const longTokens = tokens.filter((token) => [...token].length >= 3);
	const shortTokens = tokens.filter((token) => [...token].length < 3);
	const conditions: string[] = [];
	const parameters: string[] = [];
	if (longTokens.length) {
		conditions.push("lesson_search MATCH ?");
		parameters.push(
			longTokens
				.map((token) => `"${token.replaceAll('"', '""')}"`)
				.join(" AND "),
		);
	}
	for (const token of shortTokens) {
		conditions.push(
			"instr(lesson_search.rule || ' ' || lesson_search.tags, ?) > 0",
		);
		parameters.push(token);
	}
	const { database } = openIndex(root, false);
	try {
		const ranking = longTokens.length ? "bm25(lesson_search)," : "";
		const results = database
			.prepare(`
			SELECT lessons.* FROM lesson_search JOIN lessons ON lessons.id = lesson_search.id
			WHERE ${conditions.join(" AND ")}
			ORDER BY ${ranking} lessons.date DESC, lessons.id LIMIT ?
		`)
			.all(...parameters, limit) as unknown as (Omit<
			Lesson,
			"tags" | "supersedes"
		> & { tags: string })[];
		return results.map((lesson) => ({
			...lesson,
			tags: JSON.parse(lesson.tags) as string[],
		}));
	} finally {
		database.close();
	}
}

/** Native availability is explicit: auto never downloads or compiles during search. */
export async function findLessons(
	root: string,
	query: string,
	limit = 8,
	mode = "auto",
): Promise<SearchResult[]> {
	if (!["auto", "keyword", "vector", "hybrid"].includes(mode)) {
		throw new Error(
			"modeはauto / keyword / vector / hybridから指定してください",
		);
	}
	if (mode === "keyword") return searchLessons(root, query, limit);
	const { vec1Path } = await import("./vec1.ts");
	if (mode === "auto" && !existsSync(vec1Path(root)))
		return searchLessons(root, query, limit);
	const { searchVectors } = await import("./vector-search.ts");
	if (mode === "vector") return searchVectors(root, query, limit);
	// A wider candidate set avoids discarding matches before rank fusion.
	const candidates = Math.min(100, Math.max(limit * 3, 24));
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
		throw new Error("limitは1〜100の整数にしてください");
	}
	const keyword = searchLessons(root, query, candidates);
	const vector = searchVectors(root, query, candidates);
	const active = new Map(
		activeLessons(readLessons(root)).map((lesson) => [lesson.id, lesson]),
	);
	const combined = new Map<
		string,
		SearchResult & { rankScore: number; matches: string[] }
	>();
	const sources: [string, SearchResult[], number][] = [
		["keyword", keyword, 2],
		["vector", vector, 1],
	];
	for (const [source, rows, weight] of sources) {
		for (const [index, row] of rows.entries()) {
			const lesson = active.get(row.id);
			if (!lesson) continue;
			const result = combined.get(row.id) ?? {
				...lesson,
				rankScore: 0,
				matches: [],
			};
			combined.set(row.id, result);
			result.rankScore += weight / (60 + index + 1);
			result.matches.push(source);
			if (row.similarity !== undefined) {
				result.similarity = row.similarity;
				result.model = row.model;
			}
		}
	}
	return [...combined.values()]
		.sort(
			(left, right) =>
				right.rankScore - left.rankScore ||
				right.date.localeCompare(left.date) ||
				left.id.localeCompare(right.id),
		)
		.slice(0, limit);
}
