const usageCode =
	/\b(?:(?:subscription_sharing_(?:workplace_individual_)?)?usage_limit_(?:reached|exceeded)|usage_not_included)\b/i;
const usageDenial =
	/\b(?:usage|subscription|session|weekly) limits? (?:has been |was )?(?:reached|exceeded|exhausted)\b|\b(?:hit|reached|exceeded) (?:your|the) (?:(?:specified API|Claude(?: AI)?|ChatGPT|subscription|weekly|session) )?(?:usage limits?|session limit|weekly limit)\b|\b(?:hit|reached) your (?:Claude )?limit\s*[·,;–—-]\s*resets?\b/i;

/** Recognizes explicit subscription exhaustion, not throughput limits or the HTTP status alone. */
export function isSubscriptionUsageLimit(message: string, headers?: Headers): boolean {
	if (headers?.get("anthropic-ratelimit-unified-slow-status") === "slot_busy") return false;
	if (headers?.get("anthropic-ratelimit-unified-status") === "rejected" || usageCode.test(message)) return true;
	return usageDenial.test(message) && !/\bper (?:second|minute)\b|\b(?:rpm|tpm)\b/i.test(message);
}
