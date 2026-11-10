import assert from "node:assert/strict";
import { test } from "node:test";
import { newsletter } from "../src/astro/index.ts";
import { handleAdmin } from "../src/plugin/admin.ts";
import { setup } from "./helpers.ts";

test("newsletter() returns the EmDash plugin and an integration that mounts the routes", () => {
	const nl = newsletter({ d1Binding: "MAIN_DB", config: { publicBasePath: "news/" } });
	assert.equal(nl.name, "emdash-newsletter");
	assert.equal(nl.plugin.id, "emdash-newsletter");
	assert.equal(nl.plugin.entrypoint, "emdash-newsletter/plugin/runtime");
	assert.equal(nl.plugin.options.d1Binding, "MAIN_DB");
	assert.equal(nl.plugin.options.config?.publicBasePath, "/news");

	const routes: { pattern: string; entrypoint: string }[] = [];
	const plugins: { resolveId(id: string): string | undefined; load(id: string): string | undefined }[] = [];
	const setupHook = nl.hooks["astro:config:setup"] as (p: unknown) => void;
	setupHook({
		injectRoute: (r: { pattern: string; entrypoint: string }) => routes.push(r),
		updateConfig: (c: { vite: { plugins: typeof plugins } }) => plugins.push(...c.vite.plugins),
	});
	assert.deepEqual(routes.map((r) => [r.pattern, r.entrypoint]), [["/news/[...path]", "emdash-newsletter/astro/route"]]);
	const id = plugins[0].resolveId("virtual:emdash-newsletter/options")!;
	assert.match(plugins[0].load(id)!, /"d1Binding":"MAIN_DB"/);
	assert.equal(plugins[0].resolveId("something-else"), undefined);
});

test("injectRoutes: false leaves routing to the site", () => {
	const routes: unknown[] = [];
	const nl = newsletter({ injectRoutes: false });
	(nl.hooks["astro:config:setup"] as (p: unknown) => void)({ injectRoute: (r: unknown) => routes.push(r), updateConfig: () => {} });
	assert.equal(routes.length, 0);
	assert.equal(nl.plugin.options.config?.publicBasePath, "/newsletter");
});

test("settings page flags settings fixed in code", async () => {
	const { nl } = await setup({ config: { siteUrl: "https://example.test" } });
	const r = await handleAdmin(nl, { type: "page_load", page: "/settings" }, { role: 50 });
	const banner = r.blocks.find((b) => b.type === "banner" && String(b.title).includes("set in code"));
	assert.ok(banner, "banner shown");
	assert.match(String(banner?.description), /Site URL is configured in the site's code/);
});

test("adopts EmDash's site name and URL only when unset", async () => {
	const { configureNewsletter, adoptSiteDefaults, getNewsletter } = await import("../src/plugin/shared.ts");
	const { sqliteDb, SECRET } = await import("./helpers.ts");
	configureNewsletter({ db: sqliteDb(), secret: SECRET, logger: { info() {}, warn() {}, error() {} } });
	await adoptSiteDefaults({ name: "My Blog", url: "https://blog.example/" });
	const nl = await getNewsletter();
	let c = await nl.settings.get();
	assert.equal(c.publicationName, "My Blog");
	assert.equal(c.siteUrl, "https://blog.example");
	await nl.settings.update({ siteUrl: "https://custom.example" });
	c = await nl.settings.get();
	assert.equal(c.siteUrl, "https://custom.example");
});
