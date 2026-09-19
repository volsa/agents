import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const NOTIFICATION_TITLE = "Pi";
const NOTIFICATION_BODY = "Waiting for further input";

function isGhostty(): boolean {
	return (
		process.env.TERM_PROGRAM?.toLowerCase() === "ghostty" ||
		process.env.TERM?.toLowerCase().includes("ghostty") === true
	);
}

function sanitizeOSC(value: string): string {
	return value.replace(/[\x00-\x1f\x7f;]/g, " ").trim();
}

function notify(title: string, body: string): void {
	process.stdout.write(`\x1b]777;notify;${sanitizeOSC(title)};${sanitizeOSC(body)}\x07`);
}

export default function ghosttyNotify(pi: ExtensionAPI) {
	let active = false;

	pi.on("session_start", (_event, ctx) => {
		active = process.platform === "darwin" && ctx.mode === "tui" && isGhostty();
	});

	pi.on("agent_settled", () => {
		if (!active) return;

		// Ghostty owns the focus decision. It suppresses notifications emitted by
		// the focused surface and shows them when this split, tab, or window is not
		// focused, including when another application is active.
		notify(NOTIFICATION_TITLE, NOTIFICATION_BODY);
	});

	pi.on("session_shutdown", () => {
		active = false;
	});
}
