/**
 * Astro side of emdash-newsletter. One call gives you both halves:
 *
 *   // astro.config.mjs
 *   import { newsletter } from "emdash-newsletter/astro";
 *   const nl = newsletter();
 *
 *   export default defineConfig({
 *     integrations: [emdash({ database: d1({ binding: "DB" }), plugins: [nl.plugin] }), nl],
 *   });
 *
 * `nl.plugin` is the EmDash plugin (admin, sending cron, publish → email, MCP).
 * `nl` itself is an Astro integration that mounts the public routes (subscribe,
 * confirm, unsubscribe, preferences, tracking, webhooks, archive) under the
 * base path, default /newsletter.
 *
 * Runs at config time in Node: it must not import runtime code.
 */
import type { AstroIntegration } from "astro";
import { newsletterPlugin } from "../plugin/index.ts";
import type { PluginOptions } from "../plugin/options.ts";

export interface NewsletterOptions extends PluginOptions {
	/** Mount the public routes. Turn off to mount `createNewsletterHandler` yourself. Default true. */
	injectRoutes?: boolean;
}

const VIRTUAL_ID = "virtual:emdash-newsletter/options";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

export type NewsletterIntegration = AstroIntegration & { plugin: ReturnType<typeof newsletterPlugin> };

export function newsletter(options: NewsletterOptions = {}): NewsletterIntegration {
	const { injectRoutes = true, ...pluginOptions } = options;
	const basePath = `/${(pluginOptions.config?.publicBasePath ?? "/newsletter").replace(/^\/+|\/+$/g, "")}`;
	const resolved: PluginOptions = { ...pluginOptions, config: { ...(pluginOptions.config ?? {}), publicBasePath: basePath } };
	return {
		name: "emdash-newsletter",
		plugin: newsletterPlugin(resolved),
		hooks: {
			"astro:config:setup": ({ injectRoute, updateConfig }) => {
				updateConfig({
					vite: {
						plugins: [
							{
								name: "emdash-newsletter:options",
								resolveId: (id: string) => (id === VIRTUAL_ID ? RESOLVED_ID : undefined),
								load: (id: string) => (id === RESOLVED_ID ? `export default ${JSON.stringify(resolved)};` : undefined),
							},
						],
					},
				});
				if (injectRoutes) {
					injectRoute({ pattern: `${basePath}/[...path]`, entrypoint: "emdash-newsletter/astro/route", prerender: false });
				}
			},
		},
	};
}

export default newsletter;
