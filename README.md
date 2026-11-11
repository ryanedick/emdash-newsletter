# emdash-newsletter

A complete newsletter platform for [EmDash](https://github.com/emdash-cms/emdash) sites, in the spirit of beehiiv and Kajabi.

**Your site owns the list. The email provider only delivers.** Subscribers, campaigns, stats and history live in your own database. You can switch from Bird to Mailgun, SES or any SMTP server without losing anything.

- Sign-up forms with double opt-in, a preference center and one-click unsubscribe
- Campaigns in Markdown, HTML or straight from published posts, with scheduling and A/B subject lines
- Segments, topics, tags, drip automations, referrals with rewards, and sponsor ad slots
- Open and click tracking, bounce and complaint handling, and a web archive of past issues
- A full admin inside EmDash, plus MCP tools so AI agents can draft, test and schedule issues
- Works with **Bird, any SMTP server, SparkPost, Mailgun, Postmark, Resend, SendGrid and Amazon SES**

> **Requirements:** EmDash 1.3+ on **Cloudflare Workers with D1** (the default `npm create emdash` setup), Astro 6+, Node 22.6+ for builds.

## Quick start

**1. Install**

```bash
npm install emdash-newsletter
```

**2. Add it to `astro.config.mjs`**

```js
import emdash from "emdash/astro";
import { newsletter } from "emdash-newsletter/astro";

const nl = newsletter();

export default defineConfig({
  integrations: [
    emdash({
      database: d1({ binding: "DB" }),
      storage: r2({ binding: "MEDIA" }),
      plugins: [nl.plugin], // the EmDash plugin: admin, sending, publish → email
    }),
    nl, // the Astro integration: public routes under /newsletter
  ],
});
```

**3. Add a sign-up form anywhere**

```astro
---
import SubscribeForm from "emdash-newsletter/components/SubscribeForm.astro";
---
<SubscribeForm heading="Get new posts by email" source="footer" />
```

**4. Pick an email provider.** Open the EmDash admin, go to **Newsletter → Email settings**, choose your provider and enter its credentials. Then fill in the From address and your postal address, which goes in the email footer as US anti-spam law (CAN-SPAM) requires. A banner lists anything still missing, and nothing sends until it's complete.

That's all. Sending runs on EmDash's per-minute cron, which the default Cloudflare template already has (`"triggers": { "crons": ["* * * * *"] }` in `wrangler.jsonc`).

### Secrets

The plugin signs every link in every email and encrypts provider credentials. By default it uses EmDash's own `EMDASH_ENCRYPTION_KEY`. To keep them separate, set a dedicated secret:

```bash
npx wrangler secret put NEWSLETTER_SECRET
```

Use 32 or more random characters, and **don't rotate it casually**: unsubscribe links in emails you've already sent stop working, and saved provider keys become unreadable.

## Features

| Area | What you get |
|---|---|
| **Subscribers** | Double opt-in, re-confirmation for returning readers, source and UTM capture, consent IP and time, tags, custom fields, topics (lists), CSV import and export, GDPR erase |
| **Preference center** | Readers change their name and topics or resubscribe. One-click unsubscribe ([RFC 8058](https://www.rfc-editor.org/rfc/rfc8058)) plus `List-Unsubscribe` headers |
| **Campaigns** | Markdown, HTML or Portable Text. Merge tags (`{{first_name\|there}}`, `{{attr.company}}`), buttons (`[[Label]](https://…)`), preview text, test sends, scheduling in your time zone, cancel mid-send |
| **A/B tests** | Subject line A vs B on a sample. The winner, by clicks or opens, goes to everyone else |
| **Segments** | Tags, topics, source, email, custom fields, sign-up or confirmation date, opened or clicked within N days, referral count. Match all or any |
| **Automations** | Drip sequences triggered on subscribe or when a tag is added, with per-step delays and an optional exit tag |
| **Publish → email** | Publishing an entry in a chosen collection creates a draft issue or sends it. Each entry sends at most once |
| **Referrals** | A personal referral link in every issue, milestone rewards (a tag plus a hook for real rewards), leaderboard |
| **Sponsors** | One ad per issue date (booked or on hold), hidden for chosen tags (e.g. paying members), inventory calendar, per-slot clicks |
| **Analytics** | Sends, deliveries, unique opens and clicks, click-to-open, per-link clicks, opens over time, bounces, complaints, unsubscribes, list growth |
| **Web archive** | Public or members-only issue pages with a subscribe form |
| **Deliverability** | Suppression list, provider bounce and complaint events, retries with backoff, per-minute send cap, honeypot, per-IP rate limit, optional Cloudflare Turnstile |
| **Admin** | EmDash pages for overview, campaigns, subscribers, segments and topics, automations, sponsors and settings, plus a dashboard widget |
| **AI agents** | MCP tools: stats, list campaigns, campaign stats, create draft, send test, schedule, send, add or find subscribers, sponsor calendar, book a sponsor. Sending and scheduling are marked destructive |

## Email providers

| Provider | How it sends | Batching | Events webhook |
|---|---|---|---|
| **Bird** | API | 100 per request | `/newsletter/webhooks/bird` (signed) |
| **Any SMTP server** | TLS (465) or STARTTLS (587/2525), AUTH PLAIN/LOGIN | One connection per batch | `/newsletter/webhooks/generic` |
| SparkPost | API | – | `/newsletter/webhooks/sparkpost` |
| Mailgun | API | – | `/newsletter/webhooks/mailgun` (signed) |
| Postmark | API | 500 per request | `/newsletter/webhooks/postmark` |
| Resend | API | 100 per request | `/newsletter/webhooks/resend` (signed) |
| SendGrid | API | – | `/newsletter/webhooks/sendgrid` |
| Amazon SES | API | – | `/newsletter/webhooks/ses` (via SNS) |

SMTP has presets for Bird, SparkPost, Mailgun, Postmark, SendGrid, Resend, Amazon SES, Brevo and Google Workspace, plus a custom server. Cloudflare Workers block outbound port 25, so use 465, 587 or 2525.

**Delivery events.** Point your provider's event webhook at the URL shown under **Email settings → Provider**. The URL includes a `?key=` token. For Bird, Resend and Mailgun, also paste the signing secret so each event's signature is checked. Hard bounces, spam complaints and provider unsubscribes then remove the reader automatically.

<details>
<summary><strong>Bird setup, step by step</strong></summary>

1. In Bird, add and verify a sending domain, ideally a subdomain such as `news.example.com`. Bird gives you DKIM, return-path and DMARC records.
2. Create an API key with only the **emails** scope.
3. In **Email settings**, choose **Bird (API)** and paste the key. The region (`us1` or `eu1`) comes from the key prefix. Alternatively, choose **SMTP → Bird**, with username `bird` and the key as the password.
4. **Send category.** *Marketing* (the default) lets Bird apply every suppression and manage unsubscribes, and its unsubscribe events flow back to you. *Transactional* sends this plugin's own `List-Unsubscribe` headers instead.
5. Create a Bird webhook to the URL from the settings page with these events: `email.delivered`, `email.bounced`, `email.out_of_band_bounce`, `email.complained`, `email.unsubscribed`, `email.list_unsubscribed`, `email.rejected`. Paste its `whsec_…` secret into the settings.
6. Send a provider test, then a campaign test. Bird's `delivered@messagebird.dev` sandbox address is handy here.

</details>

## Public routes

Mounted by the integration under `/newsletter` by default:

| Route | Purpose |
|---|---|
| `POST /subscribe` | Sign-up (form or JSON). Honeypot field `website`, per-IP limit, optional Turnstile |
| `GET /confirm?t=` | Double opt-in confirmation |
| `GET /u?t=`, `POST /u?t=` | Unsubscribe page, and one-click unsubscribe from mail apps |
| `GET`/`POST /preferences?t=` | Preference center |
| `GET /c/<token>`, `GET /o/<token>.gif` | Click and open tracking |
| `POST /webhooks/<provider>` | Delivery events from your provider |
| `GET /r/<code>` | Referral link: remembers the referrer, then goes to your site |
| `GET /archive`, `GET /p/<slug>` | Web archive |

These are site routes rather than EmDash plugin routes because EmDash plugin routes can't serve HTML or redirect to other sites, and click tracking needs both.

## Options

```js
newsletter({
  d1Binding: "DB",               // D1 binding with the newsletter tables (default "DB")
  secretEnv: "NEWSLETTER_SECRET", // falls back to EMDASH_ENCRYPTION_KEY
  permission: "content:publish_any", // who can use the admin (default: Editors and up)
  cronSchedule: "* * * * *",
  injectRoutes: true,            // false: mount createNewsletterHandler yourself
  config: {                      // fixed in code; wins over the admin form
    publicBasePath: "/newsletter",
    siteUrl: "https://example.com",
  },
});
```

Anything in `config` can also be set in the admin. When a value is fixed in code, the settings page says so. The publication name and site URL default to your EmDash site settings.

`<SubscribeForm>` props: `basePath`, `source`, `heading`, `text`, `buttonLabel`, `placeholder`, `askName`, `topics`, `turnstileSiteKey`, `redirect`, `class`. Style it with the `--nl-accent` and `--nl-radius` CSS custom properties, or target the `.nl-subscribe` classes.

## Using it from code

```ts
import { getNewsletter, setNewsletterHooks } from "emdash-newsletter/plugin/runtime";

setNewsletterHooks({
  onSubscribed: async (subscriber) => { /* sync to your CRM */ },
  onUnsubscribed: async (subscriber, reason) => {},
  onReferralMilestone: async (referrer, milestone, count) => { /* grant the reward */ },
  canViewArchive: async (request, issue) => isPaidMember(request), // members-only issues
});

const nl = await getNewsletter();
await nl.subscribers.subscribe({ email, source: "checkout", tags: ["customer"] });
await nl.subscribers.addTags(id, ["plan:pro"]); // fires tag-triggered automations
const issue = await nl.campaigns.createCampaign({ subject: "Hi {{first_name|there}}", content: "# Hello" });
await nl.campaigns.scheduleCampaign(issue.id, Date.parse("2026-12-01T11:00:00Z"));
```

Register hooks in a module that loads early, such as your Worker entry (`src/worker.ts`).

### After someone confirms

To mount the public routes yourself (`injectRoutes: false`), pass options to `createNewsletterHandler`. `afterConfirm` runs each time a confirmation link is opened. Return a same-origin URL (or a `Response`) to send the reader on, for example to sign them in to an account; return nothing for the built-in page.

```ts
// src/pages/newsletter/[...path].ts
const handler = createNewsletterHandler(await getNewsletter(), {
  afterConfirm: async (subscriber, { request, firstConfirmation, sentAt }) => {
    if (!sentAt || Date.now() - sentAt > 24 * 3600_000) return null; // old link: just confirm
    return `/welcome?email=${encodeURIComponent(subscriber.email)}`;
  },
});
export const ALL: APIRoute = ({ request }) => handler(request);
```

Mail scanners often open links before the reader does, so `firstConfirmation` may already be spent by the time the reader clicks, and the hook shouldn't start a session itself. Send the reader to a page with a button instead. `nl.subscribers.confirmToken(token)` gives the same details (`subscriber`, `firstConfirmation`, `sentAt`) if you handle confirmation in your own route.

To use the engine outside the plugin, call `createNewsletter({ db, secret, config, hooks, transport })` from `emdash-newsletter`. `db` is any D1-compatible database. To add a provider, implement `EmailTransport` (see `src/transport/types.ts`) and pass it as `transport`.

## How it works

- **Storage.** Everything lives in your D1 database in tables prefixed `nl_`. They create and migrate themselves on first use.
- **Sending.** Every email is a row in an outbox. The per-minute cron starts scheduled campaigns, decides A/B winners, advances automations, and sends due rows in the provider's native batches. It respects your per-minute cap, retries transient failures with backoff, and never sends the same row twice.
- **Tracking.** Opens and clicks are tracked by the plugin itself, not the provider, so stats survive a provider switch. Opens are approximate because Apple Mail Privacy Protection preloads images. Clicks are the reliable signal.

## Development

```bash
npm install
npm run typecheck
npm test        # node:test against real SQLite (node:sqlite) behind a D1-compatible wrapper
npm run build   # compiles src/ to dist/
```

The tests cover opt-in, fan-out, tracking, one-click unsubscribe, segments, A/B tests, signed webhooks, retries, rate limits, automations, referrals, sponsors, publish → email, the preference center, CSV, GDPR erase, a scripted SMTP server, provider request formats, the admin flows and the Astro integration.

## Disclaimer

This software is provided "as is", without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose and noninfringement. In no event shall the authors or copyright holders be liable for any claim, damages or other liability arising from, out of or in connection with the software or its use. See the [LICENSE](LICENSE) for the full terms.

You are responsible for how you use it. That includes complying with email and privacy laws such as CAN-SPAM, GDPR and CASL, and with your email provider's terms.

## License

[MIT](LICENSE) © Ryan Edick
