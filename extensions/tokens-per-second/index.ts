import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "tokens-per-second";

type UsageSnapshot = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
};

type StatsEntryData = UsageSnapshot & {
	elapsedSeconds: number;
};

function formatCount(value: number): string {
	return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

function formatStatus(usage: UsageSnapshot, elapsedSeconds: number): string {
	const tokensPerSecond = elapsedSeconds > 0 ? usage.output / elapsedSeconds : 0;
	return (
		`${tokensPerSecond.toFixed(1)} tok/s, ` +
		`in ${formatCount(usage.input)}, ` +
		`out ${formatCount(usage.output)}, ` +
		`cache r/w ${formatCount(usage.cacheRead)}/${formatCount(usage.cacheWrite)}, ` +
		`${elapsedSeconds.toFixed(1)}s`
	);
}

export default function tokensPerSecond(pi: ExtensionAPI) {
	let requestStartedAt: number | undefined;
	let pendingStats: StatsEntryData | undefined;

	pi.registerEntryRenderer<StatsEntryData>(ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		if (!data || !Number.isFinite(data.elapsedSeconds) || data.elapsedSeconds <= 0) return undefined;
		return new Text(theme.fg("dim", formatStatus(data, data.elapsedSeconds)), 0, 0);
	});

	pi.on("session_start", () => {
		requestStartedAt = undefined;
		pendingStats = undefined;
	});

	pi.on("turn_start", () => {
		pendingStats = undefined;
	});

	pi.on("before_provider_request", () => {
		requestStartedAt = performance.now();
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;

		const startedAt = requestStartedAt;
		requestStartedAt = undefined;
		pendingStats = undefined;
		if (startedAt === undefined) return;
		if (event.message.stopReason === "error" || event.message.stopReason === "aborted") return;

		const elapsedSeconds = (performance.now() - startedAt) / 1000;
		if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return;

		const { input, output, cacheRead, cacheWrite } = event.message.usage;
		pendingStats = {
			input: Number.isFinite(input) ? input : 0,
			output: Number.isFinite(output) ? output : 0,
			cacheRead: Number.isFinite(cacheRead) ? cacheRead : 0,
			cacheWrite: Number.isFinite(cacheWrite) ? cacheWrite : 0,
			elapsedSeconds,
		};
	});

	pi.on("turn_end", () => {
		if (!pendingStats) return;
		pi.appendEntry<StatsEntryData>(ENTRY_TYPE, pendingStats);
		pendingStats = undefined;
	});

	pi.on("session_shutdown", () => {
		requestStartedAt = undefined;
		pendingStats = undefined;
	});
}

export const testing = { formatCount, formatStatus };
