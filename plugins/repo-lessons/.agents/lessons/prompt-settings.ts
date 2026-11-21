import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const defaultPromptSettings = { minSimilarity: 0.12, limit: 5 };

export function readPromptSettings() {
	const path =
		process.env.REPO_LESSONS_CONFIG ||
		join(homedir(), ".config", "repo-lessons", "config.json");
	try {
		const config: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!config || typeof config !== "object" || Array.isArray(config)) {
			throw new Error("Expected an object");
		}
		const {
			minSimilarity = defaultPromptSettings.minSimilarity,
			limit = defaultPromptSettings.limit,
		} = config as { minSimilarity?: unknown; limit?: unknown };
		if (
			typeof minSimilarity !== "number" ||
			!Number.isFinite(minSimilarity) ||
			minSimilarity < 0 ||
			minSimilarity > 1 ||
			typeof limit !== "number" ||
			!Number.isInteger(limit) ||
			limit < 1 ||
			limit > 100
		) {
			throw new Error("Invalid prompt search settings");
		}
		return { minSimilarity, limit };
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
			console.error("Repo Lessons: invalid or unreadable config. Using default prompt settings.");
		}
		return defaultPromptSettings;
	}
}
