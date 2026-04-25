import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execFile } from "node:child_process";

const FOCUS_REPORTING_ON = "\x1b[?1004h";
const FOCUS_REPORTING_OFF = "\x1b[?1004l";
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";

const NOTIFICATION_TITLE = "Pi";
const NOTIFICATION_BODY = "Waiting for further input";
const NOTIFICATION_SOUND = process.env.PI_MACOS_NOTIFY_SOUND ?? "Glass";
const DEBOUNCE_MS = 1500;

function isMacOS(): boolean {
	return process.platform === "darwin";
}

function escapeAppleScriptString(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function sanitizeOSC(value: string): string {
	return value.replace(/[\x00-\x1f\x7f;]/g, " ").trim();
}

function sendOSC777Notification(title: string, body: string): void {
	// Ghostty and iTerm2 turn this into a native macOS notification from the
	// terminal app itself, which gives us the correct app icon. Sound is then
	// controlled by macOS notification settings for that terminal app.
	process.stdout.write(`\x1b]777;notify;${sanitizeOSC(title)};${sanitizeOSC(body)}\x07`);
}

function sendAppleScriptNotification(title: string, body: string): void {
	const sound = NOTIFICATION_SOUND === "none" ? "" : ` sound name "${escapeAppleScriptString(NOTIFICATION_SOUND)}"`;
	const script = `display notification "${escapeAppleScriptString(body)}" with title "${escapeAppleScriptString(title)}"${sound}`;
	execFile("osascript", ["-e", script], { timeout: 5000 }, () => {
		// Intentionally ignore failures. Notifications may be disabled or unavailable,
		// but the extension should never interfere with the agent turn finishing.
	});
}

function sendMacOSNotification(title: string, body: string): void {
	const transport = process.env.PI_MACOS_NOTIFY_TRANSPORT;
	const termProgram = process.env.TERM_PROGRAM?.toLowerCase() ?? "";

	if (transport === "osascript") {
		sendAppleScriptNotification(title, body);
		return;
	}
	if (transport === "osc777") {
		sendOSC777Notification(title, body);
		return;
	}

	// Prefer terminal-native notifications for Ghostty/iTerm2 so the notification
	// uses the terminal app icon. Terminal.app does not support OSC 777, so fall
	// back to AppleScript there.
	if (termProgram.includes("apple_terminal")) {
		sendAppleScriptNotification(title, body);
	} else {
		sendOSC777Notification(title, body);
	}
}

export default function macosNotify(pi: ExtensionAPI) {
	let unsubscribeInput: (() => void) | undefined;
	let focusReportingEnabled = false;
	let unfocused = false;
	let lastNotificationAt = 0;

	function enableFocusReporting() {
		if (focusReportingEnabled) return;
		process.stdout.write(FOCUS_REPORTING_ON);
		focusReportingEnabled = true;
	}

	function disableFocusReporting() {
		if (!focusReportingEnabled) return;
		process.stdout.write(FOCUS_REPORTING_OFF);
		focusReportingEnabled = false;
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!isMacOS() || !ctx.hasUI) return;

		unsubscribeInput?.();
		unsubscribeInput = ctx.ui.onTerminalInput((data) => {
			const sawFocusOut = data.includes(FOCUS_OUT);
			const sawFocusIn = data.includes(FOCUS_IN);

			if (!sawFocusOut && !sawFocusIn) return undefined;

			if (sawFocusOut) unfocused = true;
			if (sawFocusIn) unfocused = false;

			// Do not let terminal focus-reporting escape sequences leak into the editor.
			const stripped = data.replaceAll(FOCUS_OUT, "").replaceAll(FOCUS_IN, "");
			return stripped.length === 0 ? { consume: true } : { data: stripped };
		});

		enableFocusReporting();
	});

	pi.on("agent_end", async () => {
		if (!isMacOS() || !unfocused) return;

		const now = Date.now();
		if (now - lastNotificationAt < DEBOUNCE_MS) return;
		lastNotificationAt = now;

		sendMacOSNotification(NOTIFICATION_TITLE, NOTIFICATION_BODY);
	});

	pi.on("session_shutdown", async () => {
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		disableFocusReporting();
	});
}
