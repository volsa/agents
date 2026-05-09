import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";

const RADIO_URL = "https://www.youtube.com/watch?v=AUQKjgKQF7w";

function openDefaultBrowser(url: string): Promise<void> {
	return new Promise((resolve, reject) => {
		if (process.platform === "darwin") {
			execFile("open", [url], { timeout: 5000 }, (error) => (error ? reject(error) : resolve()));
			return;
		}

		if (process.platform === "win32") {
			execFile("cmd", ["/c", "start", "", url], { timeout: 5000 }, (error) => (error ? reject(error) : resolve()));
			return;
		}

		execFile("xdg-open", [url], { timeout: 5000 }, (error) => (error ? reject(error) : resolve()));
	});
}

export default function radioExtension(pi: ExtensionAPI) {
	pi.registerCommand("radio", {
		description: "Open the radio stream in your default browser",
		handler: async (_args, ctx) => {
			try {
				await openDefaultBrowser(RADIO_URL);
				ctx.ui.notify("Opened radio in your default browser.", "success");
			} catch (error) {
				ctx.ui.notify(`Failed to open radio: ${String(error)}`, "error");
			}
		},
	});
}
