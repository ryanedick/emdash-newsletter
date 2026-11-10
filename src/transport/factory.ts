/**
 * Builds a transport from stored provider settings, and describes every
 * provider for the admin settings form. Adding a provider means one entry in
 * PROVIDERS and one case in createTransport.
 */
import { birdTransport, mailgunTransport, postmarkTransport, resendTransport, sendgridTransport, sesTransport, sparkpostTransport } from "./http.ts";
import { type SocketConnect, smtpTransport } from "./smtp.ts";
import type { EmailTransport, FetchLike } from "./types.ts";

export type ProviderType = "bird" | "smtp" | "sparkpost" | "mailgun" | "postmark" | "resend" | "sendgrid" | "ses";

/** Flat provider settings as stored (secrets are decrypted before this point). */
export interface ProviderSettings {
	type: ProviderType;
	apiKey?: string;
	region?: string;
	domain?: string;
	messageStream?: string;
	accessKeyId?: string;
	secretAccessKey?: string;
	configurationSet?: string;
	birdCategory?: "marketing" | "transactional";
	ipPoolId?: string;
	// SMTP
	smtpPreset?: string;
	host?: string;
	port?: number;
	security?: "tls" | "starttls" | "none";
	username?: string;
	password?: string;
}

export interface ProviderField {
	key: keyof ProviderSettings;
	label: string;
	kind: "text" | "secret" | "number" | "select";
	options?: { label: string; value: string }[];
	help?: string;
	required?: boolean;
}

export interface ProviderInfo {
	type: ProviderType;
	label: string;
	fields: ProviderField[];
	/** Where to point the provider's event webhook (relative to the public base path). */
	webhook: string;
	docs?: string;
}

/** SMTP presets. Picking one fills host/port/security and the username hint. */
export const SMTP_PRESETS: Record<string, { label: string; host: string; port: number; security: "tls" | "starttls"; username?: string }> = {
	"bird-us": { label: "Bird (US)", host: "us1.smtp.bird.com", port: 465, security: "tls", username: "bird" },
	"bird-eu": { label: "Bird (EU)", host: "eu1.smtp.bird.com", port: 465, security: "tls", username: "bird" },
	sparkpost: { label: "SparkPost (US)", host: "smtp.sparkpostmail.com", port: 587, security: "starttls", username: "SMTP_Injection" },
	"sparkpost-eu": { label: "SparkPost (EU)", host: "smtp.eu.sparkpostmail.com", port: 587, security: "starttls", username: "SMTP_Injection" },
	mailgun: { label: "Mailgun (US)", host: "smtp.mailgun.org", port: 587, security: "starttls" },
	"mailgun-eu": { label: "Mailgun (EU)", host: "smtp.eu.mailgun.org", port: 587, security: "starttls" },
	postmark: { label: "Postmark (broadcast)", host: "smtp-broadcasts.postmarkapp.com", port: 587, security: "starttls" },
	sendgrid: { label: "SendGrid", host: "smtp.sendgrid.net", port: 465, security: "tls", username: "apikey" },
	resend: { label: "Resend", host: "smtp.resend.com", port: 465, security: "tls", username: "resend" },
	"ses-us-east-1": { label: "Amazon SES (us-east-1)", host: "email-smtp.us-east-1.amazonaws.com", port: 465, security: "tls" },
	"ses-eu-west-1": { label: "Amazon SES (eu-west-1)", host: "email-smtp.eu-west-1.amazonaws.com", port: 465, security: "tls" },
	brevo: { label: "Brevo", host: "smtp-relay.brevo.com", port: 587, security: "starttls" },
	google: { label: "Google Workspace relay", host: "smtp-relay.gmail.com", port: 465, security: "tls" },
	custom: { label: "Custom server", host: "", port: 587, security: "starttls" },
};

const regionUsEu = [
	{ label: "US", value: "us" },
	{ label: "EU", value: "eu" },
];

export const PROVIDERS: ProviderInfo[] = [
	{
		type: "bird",
		label: "Bird (API)",
		webhook: "/webhooks/bird",
		docs: "https://bird.com/docs/guides/email/sending-email",
		fields: [
			{ key: "apiKey", label: "API key (bk_…)", kind: "secret", required: true, help: "Workspace key with the emails scope. The region comes from the key prefix." },
			{
				key: "birdCategory",
				label: "Send category",
				kind: "select",
				options: [
					{ label: "Marketing (Bird-managed unsubscribe)", value: "marketing" },
					{ label: "Transactional (our List-Unsubscribe headers)", value: "transactional" },
				],
			},
			{ key: "ipPoolId", label: "IP pool ID (optional)", kind: "text" },
		],
	},
	{
		type: "smtp",
		label: "SMTP (any provider)",
		webhook: "/webhooks/generic",
		fields: [
			{
				key: "smtpPreset",
				label: "Preset",
				kind: "select",
				options: Object.entries(SMTP_PRESETS).map(([value, p]) => ({ value, label: p.label })),
				help: "Fills host, port and encryption. Pick Custom server to enter your own.",
			},
			{ key: "host", label: "Host", kind: "text" },
			{ key: "port", label: "Port", kind: "number", help: "465 (TLS) or 587/2525 (STARTTLS). Port 25 is blocked on Workers." },
			{
				key: "security",
				label: "Encryption",
				kind: "select",
				options: [
					{ label: "Implicit TLS (465)", value: "tls" },
					{ label: "STARTTLS (587/2525)", value: "starttls" },
				],
			},
			{ key: "username", label: "Username", kind: "text", help: "Bird: bird · SendGrid: apikey · SparkPost: SMTP_Injection" },
			{ key: "password", label: "Password / API key", kind: "secret" },
		],
	},
	{
		type: "sparkpost",
		label: "SparkPost (API)",
		webhook: "/webhooks/sparkpost",
		fields: [
			{ key: "apiKey", label: "API key", kind: "secret", required: true },
			{ key: "region", label: "Region", kind: "select", options: regionUsEu },
		],
	},
	{
		type: "mailgun",
		label: "Mailgun (API)",
		webhook: "/webhooks/mailgun",
		fields: [
			{ key: "apiKey", label: "API key", kind: "secret", required: true },
			{ key: "domain", label: "Sending domain", kind: "text", required: true },
			{ key: "region", label: "Region", kind: "select", options: regionUsEu },
		],
	},
	{
		type: "postmark",
		label: "Postmark (API)",
		webhook: "/webhooks/postmark",
		fields: [
			{ key: "apiKey", label: "Server token", kind: "secret", required: true },
			{ key: "messageStream", label: "Broadcast stream ID", kind: "text", help: "Defaults to “broadcast”." },
		],
	},
	{ type: "resend", label: "Resend (API)", webhook: "/webhooks/resend", fields: [{ key: "apiKey", label: "API key", kind: "secret", required: true }] },
	{ type: "sendgrid", label: "SendGrid (API)", webhook: "/webhooks/sendgrid", fields: [{ key: "apiKey", label: "API key", kind: "secret", required: true }] },
	{
		type: "ses",
		label: "Amazon SES (API)",
		webhook: "/webhooks/ses",
		fields: [
			{ key: "accessKeyId", label: "Access key ID", kind: "text", required: true },
			{ key: "secretAccessKey", label: "Secret access key", kind: "secret", required: true },
			{ key: "region", label: "Region (e.g. us-east-1)", kind: "text", required: true },
			{ key: "configurationSet", label: "Configuration set (for events)", kind: "text" },
		],
	},
];

/** Keys whose values are encrypted at rest. */
export const SECRET_KEYS: (keyof ProviderSettings)[] = ["apiKey", "password", "secretAccessKey"];

export interface TransportDeps {
	fetch?: FetchLike;
	connect?: SocketConnect;
}

export function createTransport(s: ProviderSettings, deps: TransportDeps = {}): EmailTransport {
	const need = (v: string | undefined, label: string) => {
		if (!v) throw new Error(`Email provider ${s.type}: ${label} is not set`);
		return v;
	};
	switch (s.type) {
		case "bird":
			return birdTransport({ apiKey: need(s.apiKey, "API key"), region: s.region, category: s.birdCategory, ipPoolId: s.ipPoolId, fetch: deps.fetch });
		case "smtp": {
			const preset = s.smtpPreset ? SMTP_PRESETS[s.smtpPreset] : undefined;
			const host = s.host || preset?.host;
			return smtpTransport({
				name: s.smtpPreset?.startsWith("bird") ? "bird-smtp" : "smtp",
				host: need(host, "host"),
				port: Number(s.port || preset?.port || 587),
				security: s.security ?? preset?.security ?? "starttls",
				username: s.username || preset?.username,
				password: s.password,
				connect: deps.connect,
			});
		}
		case "sparkpost":
			return sparkpostTransport({ apiKey: need(s.apiKey, "API key"), region: s.region === "eu" ? "eu" : "us", fetch: deps.fetch });
		case "mailgun":
			return mailgunTransport({ apiKey: need(s.apiKey, "API key"), domain: need(s.domain, "domain"), region: s.region === "eu" ? "eu" : "us", fetch: deps.fetch });
		case "postmark":
			return postmarkTransport({ serverToken: need(s.apiKey, "server token"), messageStream: s.messageStream || undefined, fetch: deps.fetch });
		case "resend":
			return resendTransport({ apiKey: need(s.apiKey, "API key"), fetch: deps.fetch });
		case "sendgrid":
			return sendgridTransport({ apiKey: need(s.apiKey, "API key"), fetch: deps.fetch });
		case "ses":
			return sesTransport({
				accessKeyId: need(s.accessKeyId, "access key ID"),
				secretAccessKey: need(s.secretAccessKey, "secret access key"),
				region: need(s.region, "region"),
				configurationSet: s.configurationSet,
				fetch: deps.fetch,
			});
		default:
			throw new Error(`Unknown email provider: ${(s as { type: string }).type}`);
	}
}
