// Ambient declarations so the package type-checks without @cloudflare/workers-types.
declare module "cloudflare:sockets" {
	export const connect: unknown;
}
declare module "cloudflare:workers" {
	export const env: unknown;
}
