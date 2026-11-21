import { createHash } from "node:crypto";

export const featureDimensions = 1024;
export const featureModel = "signed-character-2-3-gram-word-tfidf-1024-v1";

/** Lexical features, not language-model embeddings or cross-language meaning. */
export function textFeatures(text: string) {
	const features = new Float64Array(featureDimensions);
	const words =
		text
			.normalize("NFKC")
			.toLowerCase()
			.match(/[\p{L}\p{N}_]+/gu) ?? [];
	const add = (feature: string, weight: number) => {
		const digest = createHash("sha256").update(feature).digest();
		const bucket = digest.readUInt32LE(0) % featureDimensions;
		features[bucket] += (digest[4] & 1 ? -1 : 1) * weight;
	};
	for (const word of words) {
		add(`word:${word}`, 2);
		const characters = [...word];
		for (const size of [2, 3]) {
			for (let start = 0; start + size <= characters.length; start++) {
				add(`char${size}:${characters.slice(start, start + size).join("")}`, 1);
			}
		}
	}
	return features;
}

export function corpusWeights(rows: readonly Float64Array[]) {
	const frequencies = new Uint32Array(featureDimensions);
	for (const row of rows) {
		for (let index = 0; index < row.length; index++) {
			if (row[index] !== 0) frequencies[index]++;
		}
	}
	return Array.from(
		frequencies,
		(frequency) => Math.log((rows.length + 1) / (frequency + 1)) + 1,
	);
}

export function featureVector(
	features: Float64Array,
	weights: readonly number[],
) {
	if (
		!Array.isArray(weights) ||
		weights.length !== featureDimensions ||
		weights.some((weight) => !Number.isFinite(weight) || weight <= 0)
	)
		throw new Error(
			"ベクトルの重みが不正です。index --mode vectorで再構築してください",
		);
	const vector = new Float32Array(featureDimensions);
	let norm = 0;
	for (let index = 0; index < featureDimensions; index++) {
		const value =
			Math.sign(features[index]) *
			Math.log1p(Math.abs(features[index])) *
			weights[index];
		vector[index] = value;
		norm += value * value;
	}
	if (norm > 0) {
		const magnitude = Math.sqrt(norm);
		for (let index = 0; index < vector.length; index++)
			vector[index] /= magnitude;
	}
	return vector;
}

export function vectorBytes(vector: Float32Array<ArrayBuffer>) {
	// Vec1's float32 blob uses native endianness, exactly like a Float32Array.
	return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}
