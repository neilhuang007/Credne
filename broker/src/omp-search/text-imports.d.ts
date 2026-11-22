// Credne shim: Bun imports the vendored prompt files as text (`with { type: "text" }`), as OMP does.
declare module "*.md" {
	const text: string;
	export default text;
}
