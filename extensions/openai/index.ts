import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CustomEditor, type EditorFactory, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
const FAST_STATE_ENTRY = "openai-fast-mode";
const STALE_AFTER_MS = 15 * 60 * 1000;
const EXPIRATION_API_FAILURE_LABEL = "expiration API failed";

type UsageWindow = {
	usedPercent: number;
	windowMinutes?: number;
	resetsAt?: number;
};

type UsageLimits = {
	primary?: UsageWindow;
	secondary?: UsageWindow;
	subscriptionExpiration?: SubscriptionExpiration;
	capturedAt: number;
};

type SubscriptionExpiration =
	| { status: "available"; expiresAt: number }
	| { status: "failed" };

type UsagePayload = {
	rate_limit?: {
		primary_window?: RateLimitWindowPayload | null;
		secondary_window?: RateLimitWindowPayload | null;
	} | null;
};

type RateLimitWindowPayload = {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_at?: number;
};

export default function openAIExtension(pi: ExtensionAPI) {
	let fastEnabled = true;
	let latestLimits: UsageLimits | undefined;
	let refreshInFlight: Promise<void> | undefined;
	let footerInstalled = false;
	let editorInstalled = false;
	let previousEditorFactory: EditorFactory | undefined;
	let requestFooterRender: (() => void) | undefined;
	let requestEditorRender: (() => void) | undefined;
	let openAILimitsLine = "";
	let openAIModeLabel = "";
	let footerCtx: ExtensionContext | undefined;

	function isOpenAISubscription(ctx: ExtensionContext): boolean {
		return ctx.model?.provider === "openai-codex" && ctx.modelRegistry.isUsingOAuth(ctx.model);
	}

	function clearStatus(ctx: ExtensionContext) {
		openAILimitsLine = "";
		openAIModeLabel = "";
		requestFooterRender = undefined;
		requestEditorRender = undefined;
		footerCtx = undefined;
		if (footerInstalled) {
			ctx.ui.setFooter(undefined);
			footerInstalled = false;
		}
		if (editorInstalled) {
			ctx.ui.setEditorComponent(previousEditorFactory);
			editorInstalled = false;
			previousEditorFactory = undefined;
		}
	}

	function updateStatus(ctx: ExtensionContext) {
		if (!isOpenAISubscription(ctx)) {
			clearStatus(ctx);
			return;
		}

		footerCtx = ctx;
		openAIModeLabel = fastEnabled ? "fast" : "normal";
		openAILimitsLine = formatCurrentLimits();
		installEditor(ctx);
		installFooter(ctx);
		requestEditorRender?.();
		requestFooterRender?.();
	}

	function formatCurrentLimits(): string {
		if (!latestLimits) return "limits:?";
		const summary = formatLimitsSummary(latestLimits);
		const stale = Date.now() - latestLimits.capturedAt > STALE_AFTER_MS;
		const limitsSummary = stale ? `${summary} stale` : summary;
		const expirationSummary = formatSubscriptionExpiration(latestLimits.subscriptionExpiration);
		return expirationSummary ? `${limitsSummary}, ${expirationSummary}` : limitsSummary;
	}

	function installEditor(ctx: ExtensionContext) {
		if (editorInstalled) return;

		previousEditorFactory = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = new OpenAIStatusEditor(tui, theme, keybindings, () => openAIModeLabel, ctx.ui.theme.fg.bind(ctx.ui.theme));
			requestEditorRender = () => tui.requestRender();
			return editor;
		});
		editorInstalled = true;
	}

	function installFooter(ctx: ExtensionContext) {
		if (footerInstalled) return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestFooterRender = () => tui.requestRender();
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose() {
					unsubscribe();
					if (requestFooterRender) requestFooterRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					return renderCompactFooter(footerCtx ?? ctx, footerData, theme, width, openAILimitsLine, () => pi.getThinkingLevel());
				},
			};
		});
		footerInstalled = true;
	}

	async function refreshUsageLimits(ctx: ExtensionContext): Promise<void> {
		if (!isOpenAISubscription(ctx)) {
			clearStatus(ctx);
			return;
		}

		if (refreshInFlight) return refreshInFlight;

		refreshInFlight = (async () => {
			try {
				const limits = await fetchUsageLimits(ctx);
				if (limits.primary || limits.secondary || !latestLimits) {
					latestLimits = limits;
				} else {
					latestLimits = {
						...latestLimits,
						subscriptionExpiration: limits.subscriptionExpiration,
						capturedAt: limits.capturedAt,
					};
				}
			} catch (error) {
				// Keep the last known limits. The next user message will retry.
				console.warn(`[openai] Failed to refresh usage limits: ${String(error)}`);
			} finally {
				updateStatus(ctx);
				refreshInFlight = undefined;
			}
		})();

		return refreshInFlight;
	}

	pi.registerCommand("fast", {
		description: "Toggle OpenAI subscription Fast mode",
		handler: async (_args, ctx) => {
			if (!isOpenAISubscription(ctx)) {
				clearStatus(ctx);
				ctx.ui.notify("Fast mode is only available for OpenAI subscription models.", "warning");
				return;
			}

			fastEnabled = !fastEnabled;
			pi.appendEntry(FAST_STATE_ENTRY, { enabled: fastEnabled });
			updateStatus(ctx);
			ctx.ui.notify(`Fast mode ${fastEnabled ? "on" : "off"}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		fastEnabled = restoreFastState(ctx, fastEnabled);
		footerInstalled = false;
		editorInstalled = false;
		previousEditorFactory = undefined;
		requestFooterRender = undefined;
		requestEditorRender = undefined;
		footerCtx = undefined;
		updateStatus(ctx);
		if (isOpenAISubscription(ctx)) await refreshUsageLimits(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		updateStatus(ctx);
		if (isOpenAISubscription(ctx)) {
			await refreshUsageLimits(ctx);
		} else {
			clearStatus(ctx);
		}
	});

	pi.on("input", (event, ctx) => {
		// Poll for each user-submitted message without delaying agent processing.
		// Extension-injected messages are not direct user submissions.
		if (event.source === "extension" || !isOpenAISubscription(ctx)) return;
		void refreshUsageLimits(ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!isOpenAISubscription(ctx) || !fastEnabled) return;
		if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;

		return {
			...(event.payload as Record<string, unknown>),
			service_tier: "priority",
		};
	});

	pi.on("after_provider_response", (event, ctx) => {
		if (!isOpenAISubscription(ctx)) return;

		const limits = parseRateLimitHeaders(event.headers);
		if (limits.primary || limits.secondary) {
			latestLimits = {
				...limits,
				subscriptionExpiration: latestLimits?.subscriptionExpiration,
			};
			updateStatus(ctx);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearStatus(ctx);
	});
}

function renderCompactFooter(
	ctx: ExtensionContext,
	footerData: {
		getGitBranch(): string | null;
		getAvailableProviderCount(): number;
	},
	theme: { fg(color: string, text: string): string },
	width: number,
	openAILimitsLine: string,
	getThinkingLevel: () => string,
): string[] {
	let totalInput = 0;
	let totalOutput = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalCost = 0;

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const message = entry.message as AssistantMessage;
			totalInput += message.usage.input;
			totalOutput += message.usage.output;
			totalCacheRead += message.usage.cacheRead;
			totalCacheWrite += message.usage.cacheWrite;
			totalCost += message.usage.cost.total;
		}
	}

	let pwd = ctx.sessionManager.getCwd();
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home && pwd.startsWith(home)) {
		pwd = `~${pwd.slice(home.length)}`;
	}

	const branch = footerData.getGitBranch();
	if (branch) pwd = `${pwd} (${branch})`;

	const sessionName = ctx.sessionManager.getSessionName();
	if (sessionName) pwd = `${pwd} • ${sessionName}`;

	const pwdLine = alignStyledLeftRight(
		pwd,
		openAILimitsLine,
		width,
		(text) => theme.fg("dim", text),
		(text) => styleOpenAILimitsLine(text, theme),
	);

	const statsParts: string[] = [];
	if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
	if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
	if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
	if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);

	const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
	if (totalCost || usingSubscription) {
		statsParts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
	}

	const contextUsage = ctx.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const contextPercentValue = contextUsage?.percent ?? 0;
	const contextPercent = contextUsage?.percent !== null && contextUsage?.percent !== undefined ? contextPercentValue.toFixed(1) : "?";
	const contextPercentDisplay =
		contextPercent === "?" ? `?/${formatTokens(contextWindow)} (auto)` : `${contextPercent}%/${formatTokens(contextWindow)} (auto)`;

	statsParts.push(contextPercentDisplay);

	let statsLeft = statsParts.join(" ");
	if (visibleWidth(statsLeft) > width) {
		statsLeft = truncateToWidth(statsLeft, width, "...");
	}

	const modelName = ctx.model?.id || "no-model";
	let rightSideWithoutProvider = modelName;
	if (ctx.model?.reasoning) {
		const thinkingLevel = getThinkingLevel();
		rightSideWithoutProvider = thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
	}

	let rightSide = rightSideWithoutProvider;
	if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
		const withProvider = `(${ctx.model.provider}) ${rightSideWithoutProvider}`;
		if (visibleWidth(statsLeft) + 2 + visibleWidth(withProvider) <= width) {
			rightSide = withProvider;
		}
	}

	const statsLine = theme.fg("dim", alignLeftRight(statsLeft, rightSide, width));
	return [pwdLine, statsLine];
}

class OpenAIStatusEditor extends CustomEditor {
	private readonly dimLabel: (text: string) => string;

	constructor(
		tui: ConstructorParameters<typeof CustomEditor>[0],
		theme: ConstructorParameters<typeof CustomEditor>[1],
		keybindings: ConstructorParameters<typeof CustomEditor>[2],
		private readonly getLabel: () => string,
		private readonly fg: (color: string, text: string) => string,
	) {
		super(tui, theme, keybindings);
		this.dimLabel = (text) => this.fg("dim", text);
	}

	render(width: number): string[] {
		const lines = super.render(width);
		const label = this.getLabel();
		if (!label || lines.length === 0 || width <= 0) return lines;

		const firstLine = stripAnsi(lines[0] ?? "");
		if (!/^─+$/.test(firstLine)) return lines;

		const prefix = "── ";
		const suffix = " ";
		const labelWidth = visibleWidth(label);
		const remaining = width - visibleWidth(prefix) - labelWidth - visibleWidth(suffix);
		if (remaining < 1) return lines;

		const styledLabel = label === "fast" ? this.fg("warning", label) : this.dimLabel(label);
		lines[0] = this.borderColor(prefix) + styledLabel + this.borderColor(suffix + "─".repeat(remaining));
		return lines;
	}
}

function styleOpenAILimitsLine(text: string, theme: { fg(color: string, text: string): string }): string {
	const failureIndex = text.indexOf(EXPIRATION_API_FAILURE_LABEL);
	if (failureIndex === -1) return theme.fg("dim", text);

	const before = text.slice(0, failureIndex);
	const failure = text.slice(failureIndex, failureIndex + EXPIRATION_API_FAILURE_LABEL.length);
	const after = text.slice(failureIndex + EXPIRATION_API_FAILURE_LABEL.length);
	return theme.fg("dim", before) + theme.fg("error", failure) + theme.fg("dim", after);
}

function alignStyledLeftRight(
	left: string,
	right: string,
	width: number,
	styleLeft: (text: string) => string,
	styleRight: (text: string) => string,
): string {
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);

	if (!right || rightWidth === 0) {
		return styleLeft(truncateToWidth(left, width, "..."));
	}

	if (leftWidth + 2 + rightWidth <= width) {
		return styleLeft(left) + " ".repeat(width - leftWidth - rightWidth) + styleRight(right);
	}

	const availableForLeft = Math.max(0, width - rightWidth - 2);
	if (availableForLeft > 0) {
		const truncatedLeft = truncateToWidth(left, availableForLeft, "...");
		const padding = " ".repeat(Math.max(2, width - visibleWidth(truncatedLeft) - rightWidth));
		return styleLeft(truncatedLeft) + padding + styleRight(right);
	}

	return styleRight(truncateToWidth(right, width, "..."));
}

function alignLeftRight(left: string, right: string, width: number): string {
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);

	if (!right || rightWidth === 0) {
		return truncateToWidth(left, width, "...");
	}

	if (leftWidth + 2 + rightWidth <= width) {
		return left + " ".repeat(width - leftWidth - rightWidth) + right;
	}

	const availableForLeft = Math.max(0, width - rightWidth - 2);
	if (availableForLeft > 0) {
		const truncatedLeft = truncateToWidth(left, availableForLeft, "...");
		const padding = " ".repeat(Math.max(2, width - visibleWidth(truncatedLeft) - rightWidth));
		return truncatedLeft + padding + right;
	}

	return truncateToWidth(right, width, "...");
}

function visibleWidth(value: string): number {
	return stripAnsi(value).length;
}

function truncateToWidth(value: string, width: number, ellipsis = "..."): string {
	const plain = stripAnsi(value);
	if (plain.length <= width) return value;
	if (width <= ellipsis.length) return ellipsis.slice(0, width);
	return plain.slice(0, width - ellipsis.length) + ellipsis;
}

function stripAnsi(value: string): string {
	return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function restoreFastState(ctx: ExtensionContext, fallback: boolean): boolean {
	let enabled = fallback;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== FAST_STATE_ENTRY) continue;
		const data = entry.data as { enabled?: unknown } | undefined;
		if (typeof data?.enabled === "boolean") enabled = data.enabled;
	}
	return enabled;
}

async function fetchUsageLimits(ctx: ExtensionContext): Promise<UsageLimits> {
	const model = ctx.model;
	if (!model) return { capturedAt: Date.now() };

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? "Missing OAuth token" : auth.error);

	const accountId = extractChatGPTAccountId(auth.apiKey);
	const baseUrl = normalizeCodexBackendBaseUrl(
		typeof model.baseUrl === "string" && model.baseUrl.trim() ? model.baseUrl.trim() : "https://chatgpt.com/backend-api",
	);
	const headers = {
		...auth.headers,
		Authorization: `Bearer ${auth.apiKey}`,
		"chatgpt-account-id": accountId,
		originator: "pi",
		"User-Agent": "pi",
	};
	const usageUrl = `${baseUrl}/wham/usage`;
	const expirationPromise = fetchSubscriptionExpiration(baseUrl, accountId, headers, ctx.signal).catch((error) => {
		console.warn(`[openai] Failed to refresh subscription expiration: ${String(error)}`);
		return { status: "failed" } as const;
	});

	const response = await fetch(usageUrl, {
		method: "GET",
		headers,
		signal: ctx.signal,
	});

	if (!response.ok) {
		throw new Error(`GET ${usageUrl} failed: ${response.status} ${response.statusText}`);
	}

	const payload = (await response.json()) as UsagePayload;
	return {
		...parseUsagePayload(payload),
		subscriptionExpiration: await expirationPromise,
	};
}

async function fetchSubscriptionExpiration(
	baseUrl: string,
	accountId: string,
	headers: Record<string, string>,
	signal: AbortSignal | undefined,
): Promise<SubscriptionExpiration> {
	// The subscriptions endpoint used by ChatGPT's billing UI may reject Codex
	// OAuth tokens. Codex itself uses the versioned accounts/check endpoint, whose
	// entitlement payload also includes the current plan's expiration timestamp.
	const endpoints = [
		{
			label: "accounts/check",
			url: `${baseUrl}/accounts/check/v4-2023-04-27`,
		},
		{
			label: "subscriptions",
			url: `${baseUrl}/subscriptions?account_id=${encodeURIComponent(accountId)}`,
		},
	];
	const failures: string[] = [];

	for (const endpoint of endpoints) {
		try {
			const response = await fetch(endpoint.url, {
				method: "GET",
				headers,
				signal,
			});

			if (!response.ok) {
				failures.push(`${endpoint.label}: HTTP ${response.status}`);
				continue;
			}

			const payload = (await response.json()) as unknown;
			const expiresAt = parseSubscriptionExpirationPayload(payload, accountId);
			if (expiresAt !== undefined) return { status: "available", expiresAt };
			failures.push(`${endpoint.label}: expiration timestamp missing`);
		} catch (error) {
			if (signal?.aborted) throw error;
			failures.push(`${endpoint.label}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	throw new Error(failures.join("; "));
}

function normalizeCodexBackendBaseUrl(baseUrl: string): string {
	let normalized = baseUrl.trim().replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) {
		normalized = normalized.slice(0, -"/codex/responses".length);
	} else if (normalized.endsWith("/responses")) {
		normalized = normalized.slice(0, -"/responses".length);
	}
	return normalized.replace(/\/+$/, "");
}

function extractChatGPTAccountId(token: string): string {
	const parts = token.split(".");
	if (parts.length !== 3) throw new Error("OpenAI subscription token is not a JWT");

	const payload = JSON.parse(Buffer.from(base64UrlToBase64(parts[1]), "base64").toString("utf8")) as Record<string, unknown>;
	const authClaim = payload["https://api.openai.com/auth"] as { chatgpt_account_id?: unknown } | undefined;
	const accountId = authClaim?.chatgpt_account_id;
	if (typeof accountId !== "string" || accountId.length === 0) {
		throw new Error("OpenAI subscription token does not include chatgpt_account_id");
	}
	return accountId;
}

function base64UrlToBase64(value: string): string {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
	const padding = (4 - (normalized.length % 4)) % 4;
	return normalized + "=".repeat(padding);
}

function parseUsagePayload(payload: UsagePayload): UsageLimits {
	return {
		primary: parsePayloadWindow(payload.rate_limit?.primary_window),
		secondary: parsePayloadWindow(payload.rate_limit?.secondary_window),
		capturedAt: Date.now(),
	};
}

function parsePayloadWindow(window: RateLimitWindowPayload | null | undefined): UsageWindow | undefined {
	if (!window || typeof window.used_percent !== "number") return undefined;
	return {
		usedPercent: window.used_percent,
		windowMinutes: typeof window.limit_window_seconds === "number" ? Math.round(window.limit_window_seconds / 60) : undefined,
		resetsAt: typeof window.reset_at === "number" ? window.reset_at : undefined,
	};
}

function parseRateLimitHeaders(headers: Record<string, string>): UsageLimits {
	const get = (name: string) => headers[name] ?? headers[name.toLowerCase()];
	const parseNumber = (name: string): number | undefined => {
		const value = get(name);
		if (value === undefined) return undefined;
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	};

	const parseHeaderWindow = (prefix: string): UsageWindow | undefined => {
		const usedPercent = parseNumber(`${prefix}-used-percent`);
		if (usedPercent === undefined) return undefined;
		return {
			usedPercent,
			windowMinutes: parseNumber(`${prefix}-window-minutes`),
			resetsAt: parseNumber(`${prefix}-reset-at`),
		};
	};

	return {
		primary: parseHeaderWindow("x-codex-primary"),
		secondary: parseHeaderWindow("x-codex-secondary"),
		capturedAt: Date.now(),
	};
}

function formatSubscriptionExpiration(expiration: SubscriptionExpiration | undefined): string | undefined {
	if (!expiration) return undefined;
	if (expiration.status === "failed") return EXPIRATION_API_FAILURE_LABEL;

	const remaining = formatResetIn(expiration.expiresAt);
	return remaining === "now" ? "expired" : `expires in ${remaining ?? "?"}`;
}

function parseSubscriptionExpirationPayload(payload: unknown, accountId?: string): number | undefined {
	const scopedPayload = findAccountPayload(payload, accountId) ?? payload;
	const fieldPriority = new Map(
		[
			"subscriptionexpiresattimestamp",
			"subscriptionexpiresat",
			"currentperiodend",
			"billingperiodend",
			"periodend",
			"renewalat",
			"renewaldate",
			"renewsat",
			"nextbillingdate",
			"activeuntil",
			"expiresat",
		].map((field, index) => [field, index]),
	);
	const candidates: Array<{ timestamp: number; priority: number }> = [];
	const seen = new Set<object>();

	const visit = (value: unknown, depth: number) => {
		if (depth > 8 || value === null || typeof value !== "object") return;
		if (seen.has(value)) return;
		seen.add(value);

		if (Array.isArray(value)) {
			for (const item of value) visit(item, depth + 1);
			return;
		}

		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
			const priority = fieldPriority.get(normalizedKey);
			if (priority !== undefined) {
				const timestamp = parseTimestampSeconds(child);
				if (timestamp !== undefined) candidates.push({ timestamp, priority });
			}
			visit(child, depth + 1);
		}
	};

	visit(scopedPayload, 0);
	if (candidates.length === 0) return undefined;

	const bestPriority = Math.min(...candidates.map((candidate) => candidate.priority));
	const preferred = candidates.filter((candidate) => candidate.priority === bestPriority).map((candidate) => candidate.timestamp);
	const now = Date.now() / 1000;
	const future = preferred.filter((timestamp) => timestamp > now).sort((a, b) => a - b);
	if (future.length > 0) return future[0];
	return preferred.sort((a, b) => b - a)[0];
}

function findAccountPayload(payload: unknown, accountId: string | undefined): unknown {
	if (!accountId || payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const accounts = (payload as Record<string, unknown>).accounts;
	if (accounts === null || typeof accounts !== "object" || Array.isArray(accounts)) return undefined;

	for (const value of Object.values(accounts as Record<string, unknown>)) {
		if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
		const record = value as Record<string, unknown>;
		const account = record.account;
		if (account && typeof account === "object" && !Array.isArray(account)) {
			const id = (account as Record<string, unknown>).account_id;
			if (id === accountId) return record;
		}
	}

	return undefined;
}

function parseTimestampSeconds(value: unknown): number | undefined {
	let timestamp: number;
	if (typeof value === "number") {
		timestamp = value;
	} else if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) return undefined;
		const numeric = Number(trimmed);
		timestamp = Number.isFinite(numeric) ? numeric : Date.parse(trimmed) / 1000;
	} else {
		return undefined;
	}

	if (!Number.isFinite(timestamp) || timestamp <= 0) return undefined;
	if (timestamp > 100_000_000_000) timestamp /= 1000;
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

function formatLimitsSummary(limits: UsageLimits): string {
	const parts = [formatWindow("5h", limits.primary), formatWindow("7d", limits.secondary)].filter(
		(part): part is string => Boolean(part),
	);
	return parts.length > 0 ? parts.join(", ") : "limits:?";
}

function formatWindow(fallbackLabel: string, window: UsageWindow | undefined): string | undefined {
	if (!window) return undefined;
	const label = window.windowMinutes ? formatWindowLabel(window.windowMinutes, fallbackLabel) : fallbackLabel;
	const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
	const reset = formatResetIn(window.resetsAt);
	return `${label}: ${remaining.toFixed(0)}%${reset ? ` (${reset})` : ""}`;
}

function formatWindowLabel(minutes: number, fallback: string): string {
	if (minutes === 300) return "5h";
	if (minutes === 10080) return "7d";
	if (minutes % 1440 === 0) return `${minutes / 1440}d`;
	if (minutes % 60 === 0) return `${minutes / 60}h`;
	return fallback;
}

function formatResetIn(resetsAtSeconds: number | undefined): string | undefined {
	if (resetsAtSeconds === undefined) return undefined;
	const remainingMs = resetsAtSeconds * 1000 - Date.now();
	if (!Number.isFinite(remainingMs)) return undefined;
	if (remainingMs <= 0) return "now";

	const minutes = Math.max(1, Math.round(remainingMs / 60_000));
	if (minutes < 60) return `~${minutes}m`;

	const hours = Math.round(minutes / 60);
	if (hours < 48) return `~${hours}h`;

	const days = Math.round(hours / 24);
	return `~${days}d`;
}
