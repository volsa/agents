import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const PROVIDER = "openai-codex";
const SETTINGS_PATH = join(getAgentDir(), "openai-status.json");
const TICK_INTERVAL_MS = 60 * 1000;

type RateLimitWindow = {
	usedPercent: number;
	windowSeconds?: number;
	resetsAt?: number;
};

type UsageState = {
	primary?: RateLimitWindow;
	secondary?: RateLimitWindow;
};

type StoredSettings = {
	fast?: boolean;
};

type UsageWindowPayload = {
	used_percent?: unknown;
	limit_window_seconds?: unknown;
	reset_at?: unknown;
};

type UsagePayload = {
	rate_limit?: {
		primary_window?: UsageWindowPayload | null;
		secondary_window?: UsageWindowPayload | null;
	} | null;
};

function readFastSetting(): boolean {
	try {
		const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as StoredSettings;
		return parsed.fast === true;
	} catch {
		return false;
	}
}

function writeFastSetting(fast: boolean): void {
	mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
	const temporaryPath = `${SETTINGS_PATH}.${process.pid}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify({ fast }, null, 2)}\n`, { mode: 0o600 });
	renameSync(temporaryPath, SETTINGS_PATH);
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseWindow(payload: UsageWindowPayload | null | undefined): RateLimitWindow | undefined {
	if (!payload) return undefined;
	const usedPercent = finiteNumber(payload.used_percent);
	if (usedPercent === undefined) return undefined;
	return {
		usedPercent,
		windowSeconds: finiteNumber(payload.limit_window_seconds),
		resetsAt: finiteNumber(payload.reset_at),
	};
}

function parseUsagePayload(payload: UsagePayload): UsageState {
	return {
		primary: parseWindow(payload.rate_limit?.primary_window),
		secondary: parseWindow(payload.rate_limit?.secondary_window),
	};
}

function parseHeaderNumber(headers: Record<string, string>, name: string): number | undefined {
	const value = headers[name] ?? headers[name.toLowerCase()];
	if (value === undefined) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseHeaderWindow(headers: Record<string, string>, name: "primary" | "secondary"): RateLimitWindow | undefined {
	const usedPercent = parseHeaderNumber(headers, `x-codex-${name}-used-percent`);
	if (usedPercent === undefined) return undefined;
	return {
		usedPercent,
		windowSeconds: (() => {
			const minutes = parseHeaderNumber(headers, `x-codex-${name}-window-minutes`);
			return minutes === undefined ? undefined : minutes * 60;
		})(),
		resetsAt: parseHeaderNumber(headers, `x-codex-${name}-reset-at`),
	};
}

function mergeWindow(previous: RateLimitWindow | undefined, update: RateLimitWindow | undefined): RateLimitWindow | undefined {
	if (!update) return previous;
	return {
		usedPercent: update.usedPercent,
		windowSeconds: update.windowSeconds ?? previous?.windowSeconds,
		resetsAt: update.resetsAt ?? previous?.resetsAt,
	};
}

function pollingIntervalMs(state: UsageState): number {
	const usedPercent = Math.max(
		...([state.primary, state.secondary]
			.map((window) => window?.usedPercent)
			.filter((value): value is number => value !== undefined && Number.isFinite(value))),
		0,
	);
	if (usedPercent >= 99) return 5_000;
	if (usedPercent >= 90) return 15_000;
	if (usedPercent >= 75) return 30_000;
	return 60_000;
}

function decodeJwtClaims(token: string): Record<string, unknown> | undefined {
	try {
		const part = token.split(".")[1];
		if (!part) return undefined;
		return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function authClaims(token: string): Record<string, unknown> | undefined {
	const claims = decodeJwtClaims(token)?.["https://api.openai.com/auth"];
	return claims && typeof claims === "object" ? (claims as Record<string, unknown>) : undefined;
}

function usageUrl(baseUrl: string): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	if (normalized.includes("/backend-api")) return `${normalized}/wham/usage`;
	return `${normalized}/api/codex/usage`;
}

function percent(window: RateLimitWindow | undefined): string {
	if (!window) return "—";
	return `${Math.round(Math.min(100, Math.max(0, window.usedPercent)))}%`;
}

function remainingSeconds(resetsAt: number | undefined, nowMs = Date.now()): number | undefined {
	if (resetsAt === undefined) return undefined;
	return Math.max(0, Math.ceil(resetsAt - nowMs / 1000));
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

function formatShortReset(resetsAt: number | undefined, nowMs = Date.now()): string {
	const total = remainingSeconds(resetsAt, nowMs);
	if (total === undefined) return "—";
	const totalMinutes = Math.ceil(total / 60);
	return `${pad(Math.floor(totalMinutes / 60))}:${pad(totalMinutes % 60)}`;
}

function formatLongReset(resetsAt: number | undefined, nowMs = Date.now()): string {
	const total = remainingSeconds(resetsAt, nowMs);
	if (total === undefined) return "—";
	const totalMinutes = Math.ceil(total / 60);
	const days = Math.floor(totalMinutes / (24 * 60));
	const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
	const minutes = totalMinutes % 60;
	return `${pad(days)}:${pad(hours)}:${pad(minutes)}`;
}

function isOpenAIContext(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === PROVIDER;
}

function formatTokens(count: number): string {
	if (count < 1_000) return String(count);
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function formatCwd(cwd: string): string {
	const relativeToHome = relative(resolve(homedir()), resolve(cwd));
	const insideHome = relativeToHome === "" || (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`));
	if (!insideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

type UsageLike = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
};

function footerUsage(ctx: ExtensionContext) {
	const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let latestCacheHitRate: number | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		let value: UsageLike | undefined;
		if (entry.type === "message" && entry.message.role === "assistant") {
			value = entry.message.usage;
			const prompt = (value.input ?? 0) + (value.cacheRead ?? 0) + (value.cacheWrite ?? 0);
			latestCacheHitRate = prompt > 0 ? ((value.cacheRead ?? 0) / prompt) * 100 : undefined;
		} else if (entry.type === "message" && entry.message.role === "toolResult") {
			value = entry.message.usage;
		} else if (entry.type === "branch_summary" || entry.type === "compaction") {
			value = entry.usage;
		}
		if (!value) continue;
		totals.input += value.input ?? 0;
		totals.output += value.output ?? 0;
		totals.cacheRead += value.cacheRead ?? 0;
		totals.cacheWrite += value.cacheWrite ?? 0;
		totals.cost += value.cost?.total ?? 0;
	}
	return { totals, latestCacheHitRate };
}

export default function openAIStatus(pi: ExtensionAPI) {
	let fast = readFastSetting();
	let usage: UsageState = {};
	let active = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let fetching = false;
	let fetchController: AbortController | undefined;
	let currentContext: ExtensionContext | undefined;
	let requestFooterRender: (() => void) | undefined;
	let footerInstalled = false;

	const statusText = (ctx: ExtensionContext): string => {
		const primary = usage.primary;
		const secondary = usage.secondary;
		const details =
			`, 5h: ${percent(primary)} (resets in ${formatShortReset(primary?.resetsAt)}), ` +
			`7d: ${percent(secondary)} (resets in ${formatLongReset(secondary?.resetsAt)})`;
		return fast
			? ctx.ui.theme.fg("warning", "fast: on") + ctx.ui.theme.fg("dim", details)
			: ctx.ui.theme.fg("dim", `fast: off${details}`);
	};

	const installFooter = (ctx: ExtensionContext): void => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestFooterRender = () => tui.requestRender();
			const unsubscribe = footerData.onBranchChange(requestFooterRender);
			return {
				dispose() {
					unsubscribe();
					requestFooterRender = undefined;
					footerInstalled = false;
				},
				invalidate() {},
				render(width: number): string[] {
					let pwd = formatCwd(ctx.sessionManager.getCwd());
					const branch = footerData.getGitBranch();
					if (branch) pwd += ` (${branch})`;
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) pwd += ` • ${sessionName}`;

					const status = statusText(ctx);
					const statusWidth = visibleWidth(status);
					let firstLine: string;
					if (statusWidth >= width) {
						firstLine = truncateToWidth(status, width, theme.fg("dim", "…"));
					} else {
						const availableForPwd = width - statusWidth - 1;
						const left = truncateToWidth(theme.fg("dim", pwd), availableForPwd, theme.fg("dim", "…"));
						const padding = " ".repeat(Math.max(1, width - visibleWidth(left) - statusWidth));
						firstLine = left + padding + status;
					}

					const { totals, latestCacheHitRate } = footerUsage(ctx);
					const parts: string[] = [];
					if (totals.input) parts.push(`↑${formatTokens(totals.input)}`);
					if (totals.output) parts.push(`↓${formatTokens(totals.output)}`);
					if (totals.cacheRead) parts.push(`R${formatTokens(totals.cacheRead)}`);
					if (totals.cacheWrite) parts.push(`W${formatTokens(totals.cacheWrite)}`);
					if ((totals.cacheRead || totals.cacheWrite) && latestCacheHitRate !== undefined) {
						parts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
					}
					parts.push(`$${totals.cost.toFixed(3)} (sub)`);

					const context = ctx.getContextUsage();
					const contextWindow = context?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const contextPercent = context?.percent;
					const contextDisplay =
						contextPercent === null || contextPercent === undefined
							? `?/${formatTokens(contextWindow)} (auto)`
							: `${contextPercent.toFixed(1)}%/${formatTokens(contextWindow)} (auto)`;
					parts.push(
						contextPercent !== null && contextPercent !== undefined && contextPercent > 90
							? theme.fg("error", contextDisplay)
							: contextPercent !== null && contextPercent !== undefined && contextPercent > 70
								? theme.fg("warning", contextDisplay)
								: contextDisplay,
					);

					let stats = parts.join(" ");
					let right = ctx.model?.id ?? "no-model";
					if (ctx.model?.reasoning) right += ` • ${ctx.thinkingLevel || "off"}`;
					if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
						const withProvider = `(${ctx.model.provider}) ${right}`;
						if (visibleWidth(stats) + 2 + visibleWidth(withProvider) <= width) right = withProvider;
					}
					if (visibleWidth(stats) > width) stats = truncateToWidth(stats, width, "...");
					const availableRight = Math.max(0, width - visibleWidth(stats) - 2);
					right = truncateToWidth(right, availableRight, "");
					const secondPadding = " ".repeat(Math.max(0, width - visibleWidth(stats) - visibleWidth(right)));
					return [firstLine, theme.fg("dim", stats) + theme.fg("dim", secondPadding + right)];
				},
			};
		});
		footerInstalled = true;
	};

	const renderStatus = (ctx: ExtensionContext): void => {
		if (active && isOpenAIContext(ctx)) requestFooterRender?.();
	};

	const scheduleUsagePoll = (ctx: ExtensionContext): void => {
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = undefined;
		if (!active || !isOpenAIContext(ctx)) return;
		pollTimer = setTimeout(() => {
			pollTimer = undefined;
			void refreshUsage(ctx);
		}, pollingIntervalMs(usage));
	};

	const refreshUsage = async (ctx: ExtensionContext): Promise<void> => {
		if (!active || !isOpenAIContext(ctx) || fetching) return;
		fetching = true;
		fetchController?.abort();
		fetchController = new AbortController();
		try {
			const resolved = await ctx.modelRegistry.getProviderAuth(PROVIDER);
			const token = resolved?.auth.apiKey;
			if (!token) return;
			const claims = authClaims(token);
			const accountId = claims?.chatgpt_account_id;
			const baseUrl = resolved?.auth.baseUrl ?? ctx.model?.baseUrl ?? "https://chatgpt.com/backend-api";
			const headers: Record<string, string> = {
				Authorization: `Bearer ${token}`,
				"User-Agent": "pi-openai-status",
				originator: "pi",
			};
			if (typeof accountId === "string" && accountId) headers["ChatGPT-Account-Id"] = accountId;
			if (claims?.chatgpt_account_is_fedramp === true) headers["X-OpenAI-Fedramp"] = "true";

			const response = await fetch(usageUrl(baseUrl), {
				headers,
				signal: fetchController.signal,
			});
			if (!response.ok) throw new Error(`usage request failed (${response.status})`);
			usage = parseUsagePayload((await response.json()) as UsagePayload);
			renderStatus(ctx);
		} catch {
			// Keep the last good snapshot. The next scheduled poll retries quietly.
		} finally {
			fetching = false;
			if (active && currentContext === ctx) scheduleUsagePoll(ctx);
		}
	};

	const activateForContext = (ctx: ExtensionContext): void => {
		currentContext = ctx;
		active = isOpenAIContext(ctx);
		if (!active) {
			fetchController?.abort();
			if (pollTimer) clearTimeout(pollTimer);
			pollTimer = undefined;
			requestFooterRender = undefined;
			if (footerInstalled) ctx.ui.setFooter(undefined);
			return;
		}
		installFooter(ctx);
		renderStatus(ctx);
		void refreshUsage(ctx);
	};

	pi.registerCommand("openai-fast", {
		description: "Toggle OpenAI Codex fast mode",
		handler: async (_args, ctx) => {
			if (!isOpenAIContext(ctx)) {
				ctx.ui.notify("OpenAI fast mode is only available with the openai-codex provider.", "warning");
				return;
			}
			fast = !fast;
			try {
				writeFastSetting(fast);
			} catch (error) {
				ctx.ui.notify(`Fast mode changed, but could not save the setting: ${String(error)}`, "warning");
			}
			renderStatus(ctx);
			ctx.ui.notify(`OpenAI fast mode ${fast ? "enabled" : "disabled"}.`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		activateForContext(ctx);
		timer = setInterval(() => {
			if (currentContext && active) renderStatus(currentContext);
		}, TICK_INTERVAL_MS);
	});

	pi.on("model_select", (_event, ctx) => {
		activateForContext(ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!fast || !isOpenAIContext(ctx) || !event.payload || typeof event.payload !== "object") return;
		return { ...(event.payload as Record<string, unknown>), service_tier: "priority" };
	});

	pi.on("after_provider_response", (event, ctx) => {
		if (!active || !isOpenAIContext(ctx)) return;
		const headers = event.headers as Record<string, string>;
		const primary = parseHeaderWindow(headers, "primary");
		const secondary = parseHeaderWindow(headers, "secondary");
		if (!primary && !secondary) return;
		usage = {
			primary: mergeWindow(usage.primary, primary),
			secondary: mergeWindow(usage.secondary, secondary),
		};
		renderStatus(ctx);
		scheduleUsagePoll(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		active = false;
		currentContext = undefined;
		fetchController?.abort();
		fetchController = undefined;
		if (timer) clearInterval(timer);
		timer = undefined;
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = undefined;
		requestFooterRender = undefined;
		if (footerInstalled) ctx.ui.setFooter(undefined);
	});
}

export const testing = {
	formatLongReset,
	formatShortReset,
	parseUsagePayload,
	usageUrl,
};
