export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

/** Check that a payload key survives HTTP header serialization unchanged. */
export function isOpenAIHeaderSafePromptCacheKey(key: unknown): key is string {
	return (
		typeof key === "string" && key.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH && /^[!-~](?:[ -~]*[!-~])?$/.test(key)
	);
}

export function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
	if (key === undefined) return undefined;
	const chars = Array.from(key);
	if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return key;
	return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}
