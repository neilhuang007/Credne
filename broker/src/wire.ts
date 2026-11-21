export type WireObject = Record<string, unknown>;
export function object(value: unknown): WireObject {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as WireObject) : {};
}
export function text(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
export function array(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}
export function stringArray(value: unknown): string[] {
	return array(value).filter((entry): entry is string => typeof entry === "string");
}
export function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
