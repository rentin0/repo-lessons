import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	linkSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export interface LessonRecord {
	version: 1;
	date: string;
	rule: string;
	tags: string[];
	supersedes: string[];
}

export interface Lesson extends LessonRecord {
	id: string;
	path: string;
}

const recordFields = ["version", "date", "rule", "tags", "supersedes"];
const idPattern = /^[a-f0-9]{64}$/;

/** Canonical bytes make identical additions produce the same Git file. */
export function normalizeLesson(input: unknown): LessonRecord {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new Error("教訓はオブジェクトで指定してください");
	}
	if (Object.keys(input).some((key) => !recordFields.includes(key))) {
		throw new Error("未対応の教訓フィールドがあります");
	}
	const fields = input as Partial<Record<keyof LessonRecord, unknown>>;
	if (fields.version !== 1) {
		throw new Error("教訓のversionは1にしてください");
	}
	if (
		typeof fields.date !== "string" ||
		!/^\d{4}-\d{2}-\d{2}$/.test(fields.date) ||
		Number.isNaN(Date.parse(`${fields.date}T00:00:00Z`)) ||
		new Date(`${fields.date}T00:00:00Z`).toISOString().slice(0, 10) !==
			fields.date
	) {
		throw new Error("dateは実在する日付をYYYY-MM-DDで指定してください");
	}
	if (typeof fields.rule !== "string" || !fields.rule.trim()) {
		throw new Error("教訓のruleを空にはできません");
	}
	if (
		!Array.isArray(fields.tags) ||
		fields.tags.some((tag) => typeof tag !== "string" || !tag.trim())
	) {
		throw new Error("tagsは空でない文字列の配列にしてください");
	}
	if (
		!Array.isArray(fields.supersedes) ||
		fields.supersedes.some(
			(id) => typeof id !== "string" || !idPattern.test(id),
		)
	) {
		throw new Error("supersedesには置き換える教訓の64桁IDを指定してください");
	}
	return {
		version: 1,
		date: fields.date,
		rule: fields.rule.trim(),
		tags: [...new Set(fields.tags.map((tag) => tag.trim()))].sort(),
		supersedes: [...new Set(fields.supersedes)].sort(),
	};
}

export function serializeLesson(input: unknown) {
	return `${JSON.stringify(normalizeLesson(input), null, 2)}\n`;
}

export function lessonId(input: LessonRecord) {
	return createHash("sha256").update(serializeLesson(input)).digest("hex");
}

function recordPath(root: string, lesson: LessonRecord) {
	const [year, month, day] = lesson.date.split("-");
	return join(
		root,
		".agents/lessons/records",
		year,
		month,
		`${day}_${lessonId(lesson).slice(0, 24)}.json`,
	);
}

/** Read the old log too, so additions from pre-migration branches remain visible. */
export function readLegacyLessons(root: string): Lesson[] {
	const path = join(root, ".agents/lessons.md");
	if (!existsSync(path)) return [];
	const lessons = [];
	let tags: string[] = [];
	for (const [index, line] of readFileSync(path, "utf8")
		.split("\n")
		.entries()) {
		if (/^(<<<<<<<|=======|>>>>>>>)/.test(line)) {
			throw new Error(`${path}:${index + 1}: 競合マーカーが残っています`);
		}
		if (line.startsWith("## ")) tags = [line.slice(3).trim()];
		if (!line.startsWith("- ")) continue;
		const match = line.match(
			/^- (\d{4}-\d{2}-\d{2})(（\d{4}-\d{2}-\d{2}追補）| \/ \d{4}-\d{2}-\d{2})?: (.+)$/,
		);
		if (!match) throw new Error(`${path}:${index + 1}: 教訓の書式が不正です`);
		const lesson = normalizeLesson({
			version: 1,
			date: match[1],
			rule: match[2] ? `${match[3]} [${match[1]}${match[2]}]` : match[3],
			tags,
			supersedes: [],
		});
		lessons.push({
			...lesson,
			id: lessonId(lesson),
			path: `.agents/lessons.md:${index + 1}`,
		});
	}
	return lessons;
}

/** Fail on edited records instead of silently changing an immutable lesson. */
export function readLessons(root: string): Lesson[] {
	root = resolve(root);
	const lessons = new Map(
		readLegacyLessons(root).map((lesson) => [lesson.id, lesson]),
	);
	const records = join(root, ".agents/lessons/records");
	if (existsSync(records)) {
		for (const file of readdirSync(records, {
			recursive: true,
			withFileTypes: true,
		})) {
			if (file.isDirectory() || file.name.startsWith(".tmp-")) continue;
			if (!file.isFile() || !file.name.endsWith(".json")) {
				throw new Error(`${file.name}: 教訓はJSONファイルにしてください`);
			}
			const path = join(file.parentPath, file.name);
			const bytes = readFileSync(path, "utf8");
			const lesson = normalizeLesson(JSON.parse(bytes));
			const id = lessonId(lesson);
			const currentPath = recordPath(root, lesson);
			const legacyPath = join(records, lesson.date, `${id}.json`);
			if (
				(path !== currentPath && path !== legacyPath) ||
				bytes !== serializeLesson(lesson)
			) {
				throw new Error(
					`${path}: 既存教訓を編集せず、置き換えを追加してください`,
				);
			}
			// Prefer the current path when an older branch also supplies this record.
			if (
				path === legacyPath &&
				lessons.get(id)?.path === relative(root, currentPath)
			)
				continue;
			lessons.set(id, { ...lesson, id, path: relative(root, path) });
		}
	}
	for (const lesson of lessons.values()) {
		for (const id of lesson.supersedes) {
			if (id === lesson.id || !lessons.has(id)) {
				throw new Error(`${lesson.path}: supersedesの参照先が存在しません`);
			}
		}
	}
	return [...lessons.values()].sort((left, right) =>
		left.id.localeCompare(right.id),
	);
}

export function activeLessons(lessons: Lesson[]) {
	const replaced = new Set(lessons.flatMap((lesson) => lesson.supersedes));
	return lessons.filter((lesson) => !replaced.has(lesson.id));
}

/** Publish complete bytes atomically; concurrent identical additions are idempotent. */
export function addLesson(root: string, input: unknown) {
	const lesson = normalizeLesson(input);
	const existing = new Set(readLessons(root).map((record) => record.id));
	if (lesson.supersedes.some((id) => !existing.has(id))) {
		throw new Error("置き換える教訓が存在しません");
	}
	const path = recordPath(root, lesson);
	const bytes = serializeLesson(lesson);
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true });
	const temporary = join(directory, `.tmp-${randomUUID()}`);
	writeFileSync(temporary, bytes, { flag: "wx" });
	let created = true;
	try {
		try {
			linkSync(temporary, path);
		} catch (error) {
			if (
				!(error instanceof Error) ||
				(error as NodeJS.ErrnoException).code !== "EEXIST"
			)
				throw error;
			if (readFileSync(path, "utf8") !== bytes)
				throw new Error(`${path}: 内容が一致しません`);
			created = false;
		}
	} finally {
		unlinkSync(temporary);
	}
	return {
		...lesson,
		id: lessonId(lesson),
		path: relative(root, path),
		created,
	};
}

export function migrateLessons(root: string) {
	const legacy = readLegacyLessons(root);
	let created = 0;
	for (const lesson of legacy) {
		const { id, path, ...record } = lesson;
		if (addLesson(root, record).created) created++;
	}
	return { legacy: legacy.length, created, total: readLessons(root).length };
}
