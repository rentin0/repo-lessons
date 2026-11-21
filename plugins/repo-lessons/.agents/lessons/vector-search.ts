import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	corpusWeights,
	featureModel,
	featureVector,
	textFeatures,
	vectorBytes,
} from "./features.ts";
import { defaultPromptSettings } from "./prompt-settings.ts";
import { indexPath } from "./search.ts";
import { activeLessons, readLessons, type Lesson } from "./store.ts";
import { loadVec1, vec1Path, vec1Revision } from "./vec1.ts";

const maximumDistance = 1 - defaultPromptSettings.minSimilarity;

function lessonFeatures(lessons: Lesson[]) {
	return lessons.map((lesson) =>
		textFeatures(`${lesson.rule} ${lesson.tags.join(" ")}`),
	);
}

/** A read-only cosine scan works in prompt hooks even before vec1 is built. */
export function searchPromptVectors(
	root: string,
	query: string,
	{ minSimilarity, limit }: typeof defaultPromptSettings,
) {
	const lessons = activeLessons(readLessons(root));
	const features = lessonFeatures(lessons);
	const weights = corpusWeights(features);
	const queryVector = featureVector(textFeatures(query), weights);
	if (!queryVector.some((value) => value !== 0)) return [];
	return lessons
		.map((lesson, index) => {
			const vector = featureVector(features[index], weights);
			const similarity = vector.reduce(
				(sum, value, dimension) => sum + value * queryVector[dimension],
				0,
			);
			return { ...lesson, similarity };
		})
		.filter((lesson) => lesson.similarity >= minSimilarity)
		.sort(
			(left, right) =>
				right.similarity - left.similarity ||
				right.date.localeCompare(left.date) ||
				left.id.localeCompare(right.id),
		)
		.slice(0, limit);
}

/** Own rows and fingerprint keep keyword searches independent of extension loading. */
function openVectorIndex(root: string, force: boolean) {
	const lessons = activeLessons(readLessons(root));
	const fingerprint = createHash("sha256")
		.update(
			JSON.stringify({ lessons, model: featureModel, vec1: vec1Revision }),
		)
		.digest("hex");
	mkdirSync(join(root, ".cache/lessons"), { recursive: true });
	const database = new DatabaseSync(indexPath(root), { allowExtension: true });
	try {
		database.exec("PRAGMA busy_timeout = 5000;");
		loadVec1(database, vec1Path(root));
		database.exec("PRAGMA journal_mode = WAL;");
		database.exec(`
			CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS vector_lessons (
				rowid INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, date TEXT NOT NULL,
				rule TEXT NOT NULL, tags TEXT NOT NULL, path TEXT NOT NULL
			);
		`);
		database.exec("BEGIN IMMEDIATE");
		try {
			const stored = database
				.prepare("SELECT value FROM metadata WHERE key = 'vector_fingerprint'")
				.get();
			if (force || stored?.value !== fingerprint) {
				const features = lessonFeatures(lessons);
				const weights = corpusWeights(features);
				database.exec(`
					DROP TABLE IF EXISTS lesson_vectors;
					DELETE FROM vector_lessons;
					CREATE VIRTUAL TABLE lesson_vectors USING vec1;
				`);
				const insertLesson = database.prepare(
					"INSERT INTO vector_lessons VALUES (?, ?, ?, ?, ?, ?)",
				);
				const insertVector = database.prepare(
					"INSERT INTO lesson_vectors(rowid,vector) VALUES (?, ?)",
				);
				for (const [index, lesson] of lessons.entries()) {
					const vector = featureVector(features[index], weights);
					if (!vector.some((value) => value !== 0)) continue;
					insertLesson.run(
						index + 1,
						lesson.id,
						lesson.date,
						lesson.rule,
						JSON.stringify(lesson.tags),
						lesson.path,
					);
					insertVector.run(index + 1, vectorBytes(vector));
				}
				database
					.prepare("INSERT INTO lesson_vectors(cmd,arg) VALUES ('rebuild', ?)")
					.run(JSON.stringify({ index: "flat", distance: "cos" }));
				const metadata = database.prepare(
					"INSERT OR REPLACE INTO metadata VALUES (?, ?)",
				);
				metadata.run("vector_weights", JSON.stringify(weights));
				metadata.run("vector_fingerprint", fingerprint);
			}
			const weights: number[] = JSON.parse(
				String(
					database
						.prepare("SELECT value FROM metadata WHERE key = 'vector_weights'")
						.get()?.value,
				),
			);
			database.exec("COMMIT");
			const count = database
				.prepare("SELECT count(*) AS count FROM vector_lessons")
				.get()?.count;
			return { database, weights, count };
		} catch (error) {
			database.exec("ROLLBACK");
			throw error;
		}
	} catch (error) {
		database.close();
		throw error;
	}
}

export function rebuildVectorIndex(root: string) {
	const { database, count } = openVectorIndex(root, true);
	database.close();
	return { indexed: count, model: featureModel, database: indexPath(root) };
}

export function searchVectors(root: string, query: string, limit = 8) {
	if (!query.trim()) throw new Error("検索語を指定してください");
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
		throw new Error("limitは1〜100の整数にしてください");
	}
	const { database, weights, count } = openVectorIndex(root, false);
	try {
		if (count === 0) return [];
		const vector = featureVector(textFeatures(query), weights);
		if (!vector.some((value) => value !== 0)) return [];
		const results = database
			.prepare(`
			SELECT lessons.id, lessons.date, lessons.rule, lessons.tags, lessons.path, neighbors.distance
			FROM lesson_vectors(?, ?) AS neighbors
			JOIN vector_lessons AS lessons ON lessons.rowid = neighbors.rowid
			WHERE neighbors.distance <= ?
			ORDER BY neighbors.distance, lessons.date DESC, lessons.id
			LIMIT ?
		`)
			.all(
				vectorBytes(vector),
				JSON.stringify({ K: limit }),
				maximumDistance,
				limit,
			) as unknown as (Omit<Lesson, "tags" | "supersedes"> & {
			tags: string;
			distance: number;
		})[];
		return results.map((lesson) => ({
			...lesson,
			tags: JSON.parse(lesson.tags) as string[],
			similarity: 1 - lesson.distance,
			model: featureModel,
		}));
	} finally {
		database.close();
	}
}
