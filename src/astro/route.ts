/** The public route injected by the `newsletter()` Astro integration. */
import options from "virtual:emdash-newsletter/options";
import { createNewsletterHandler } from "../handler.ts";
import { getNewsletter, setPluginOptions } from "../plugin/shared.ts";

export const prerender = false;

let handler: ((request: Request) => Promise<Response>) | null = null;
let forInstance: unknown = null;

export const ALL = async ({ request }: { request: Request }): Promise<Response> => {
	setPluginOptions(options);
	const nl = await getNewsletter();
	if (!handler || forInstance !== nl) {
		handler = createNewsletterHandler(nl);
		forInstance = nl;
	}
	return handler(request);
};
