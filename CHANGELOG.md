# Changelog

## 0.1.0 (2026-11-09)

First public release.

- `newsletter()` Astro integration: returns the EmDash plugin (`nl.plugin`) and mounts the public routes under `/newsletter`.
- `<SubscribeForm>` component with no-JS fallback, honeypot and optional Turnstile.
- Subscribers with double opt-in, topics, tags, custom fields, preference center, one-click unsubscribe, CSV import and export, GDPR erase.
- Campaigns in Markdown, HTML or Portable Text with merge tags, scheduling, test sends and A/B subject lines.
- Segments, drip automations with exit tags, referrals with milestone rewards, sponsor slots.
- Publish → email for any EmDash collection.
- Open and click tracking, provider delivery events, suppression list, retries and per-minute send cap.
- Providers: Bird, any SMTP server, SparkPost, Mailgun, Postmark, Resend, SendGrid, Amazon SES.
- EmDash admin pages, dashboard widget and MCP tools.
- Publication name and site URL default to the EmDash site settings.
