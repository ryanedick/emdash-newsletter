/**
 * EmDash plugin descriptor. Import this in astro.config.mjs:
 *
 *   import { newsletterPlugin } from "emdash-newsletter/plugin";
 *   emdash({ plugins: [newsletterPlugin({ d1Binding: "DB" })] })
 *
 * Most sites should use `newsletter()` from "emdash-newsletter/astro" instead,
 * which also mounts the public routes.
 *
 * This module runs at config time (Node), so it must not import runtime code.
 * The runtime lives in ./runtime.ts, which EmDash loads in the Worker.
 */
import type { PluginOptions } from "./options.ts";

export type { PluginOptions } from "./options.ts";

export const PLUGIN_ID = "emdash-newsletter";
export const PLUGIN_VERSION = "0.1.0";

export const ADMIN_PAGES = [
	{ path: "/", label: "Newsletter", icon: "mail", group: "Newsletter" },
	{ path: "/campaigns", label: "Campaigns", icon: "send", group: "Newsletter" },
	{ path: "/subscribers", label: "Subscribers", icon: "users", group: "Newsletter" },
	{ path: "/audience", label: "Segments & topics", icon: "filter", group: "Newsletter" },
	{ path: "/automations", label: "Automations", icon: "zap", group: "Newsletter" },
	{ path: "/sponsors", label: "Sponsors", icon: "calendar", group: "Newsletter" },
	{ path: "/settings", label: "Email settings", icon: "settings", group: "Newsletter" },
];

export function newsletterPlugin(options: PluginOptions = {}) {
	return {
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		entrypoint: "emdash-newsletter/plugin/runtime",
		format: "native" as const,
		options,
		adminPages: ADMIN_PAGES,
		adminWidgets: [{ id: "newsletter-overview", title: "Newsletter", size: "half" as const }],
	};
}

/** @deprecated Use `newsletterPlugin` (or `newsletter()` from emdash-newsletter/astro). */
export const newslettersPlugin = newsletterPlugin;

export default newsletterPlugin;
