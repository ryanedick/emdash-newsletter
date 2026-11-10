import assert from "node:assert/strict";
import { test } from "node:test";
import { applyMergeTags, htmlToText, rewriteLinks } from "../src/render/email.ts";
import { markdownToHtml, markdownToText } from "../src/render/markdown.ts";
import { portableTextToHtml } from "../src/render/portable-text.ts";
import { emailStyles } from "../src/render/styles.ts";
import { nextTimeInZone } from "../src/util.ts";

const s = emailStyles("#123456");

test("markdown: structure, buttons, escaping and unsafe links", () => {
	const html = markdownToHtml("# Title\n\nHello **bold** and *it* <script>x</script>\n\n- one\n- two\n\n[[Go]](https://x.test)\n\n[bad](javascript:alert(1))\n\n```\ncode <b>\n```", s);
	assert.match(html, /<h1 style="[^"]+">Title<\/h1>/);
	assert.match(html, /<strong>bold<\/strong>/);
	assert.match(html, /<em>it<\/em>/);
	assert.match(html, /&lt;script&gt;/);
	assert.match(html, /<ul style="[^"]+"><li[^>]*>one<\/li><li[^>]*>two<\/li><\/ul>/);
	assert.match(html, /<a href="https:\/\/x\.test" style="[^"]*background:#123456/);
	assert.ok(!html.includes("javascript:"));
	assert.match(html, /<pre[^>]*>code &lt;b&gt;<\/pre>/);
	assert.match(markdownToText("[[Go]](https://x.test) and [a](https://a.test)"), /Go: https:\/\/x\.test and a \(https:\/\/a\.test\)/);
});

test("portable text: marks, links, lists, images and custom blocks", () => {
	const html = portableTextToHtml(
		[
			{ _type: "block", style: "h2", children: [{ _type: "span", text: "Head" }] },
			{ _type: "block", style: "normal", markDefs: [{ _key: "l1", _type: "link", href: "/tips/x" }], children: [{ _type: "span", text: "link", marks: ["l1", "strong"] }] },
			{ _type: "block", listItem: "number", children: [{ _type: "span", text: "a" }] },
			{ _type: "block", listItem: "number", children: [{ _type: "span", text: "b" }] },
			{ _type: "image", asset: { url: "/media/a.png" }, alt: "A" },
			{ _type: "promptSnippet", text: "Do X" },
		],
		s,
		{ baseUrl: "https://site.test", blocks: { promptSnippet: (b) => `<pre>${b.text}</pre>` } },
	);
	assert.match(html, /<h2[^>]*>Head<\/h2>/);
	assert.match(html, /<a href="https:\/\/site\.test\/tips\/x"[^>]*><strong>link<\/strong><\/a>/);
	assert.match(html, /<ol[^>]*><li[^>]*>a<\/li><li[^>]*>b<\/li><\/ol>/);
	assert.match(html, /<img src="https:\/\/site\.test\/media\/a\.png" alt="A"/);
	assert.match(html, /<pre>Do X<\/pre>/);
});

test("merge tags escape in HTML and fall back", () => {
	assert.equal(applyMergeTags("Hi {{first_name|there}}!", {}, "text"), "Hi there!");
	assert.equal(applyMergeTags("Hi {{ FIRST_NAME }}", { first_name: "<b>" }, "html"), "Hi &lt;b&gt;");
	assert.equal(applyMergeTags("{{attr.company}}", { "attr.company": "Acme" }, "text"), "Acme");
});

test("link rewriting skips mailto and keeps others", () => {
	const out = rewriteLinks('<a href="https://a.test/?x=1&amp;y=2">a</a><a href="mailto:x@y.z">m</a>', (u) => `https://t.test/c?u=${encodeURIComponent(u)}`);
	assert.match(out, /https:\/\/t\.test\/c\?u=https%3A%2F%2Fa\.test%2F%3Fx%3D1%26y%3D2/);
	assert.match(out, /mailto:x@y\.z/);
	assert.equal(htmlToText('<p>Read <a href="https://a.test">this</a></p><ul><li>one</li></ul>'), "Read this (https://a.test)\n\n- one");
});

test("next 06:00 New York handles DST", () => {
	const winter = nextTimeInZone("06:00", "America/New_York", Date.UTC(2026, 0, 10, 12, 0));
	assert.equal(new Date(winter).toISOString(), "2026-01-11T11:00:00.000Z");
	const summer = nextTimeInZone("06:00", "America/New_York", Date.UTC(2026, 6, 10, 5, 0));
	assert.equal(new Date(summer).toISOString(), "2026-07-10T10:00:00.000Z");
});
