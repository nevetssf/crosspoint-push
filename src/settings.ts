import { App, Notice, PluginSettingTab, Setting, normalizePath, requestUrl } from "obsidian";
import type CrossPointPushPlugin from "./main";
import { CrossPointDevice } from "./device";

export type BundleMode = "per-note" | "per-folder";

export interface CrossPointSettings {
	host: string;
	sourceFolder: string;
	destFolder: string;
	mode: BundleMode;
	includeImages: boolean;
	addTitleHeading: boolean;
	mirrorDeletes: boolean;
	author: string;
}

export const DEFAULT_SETTINGS: CrossPointSettings = {
	host: "crosspoint.local",
	sourceFolder: "",
	destFolder: "/Obsidian",
	mode: "per-note",
	includeImages: true,
	addTitleHeading: true,
	mirrorDeletes: false,
	author: "",
};

/** Settings that change EPUB bytes; part of the cache key. */
export function renderSignature(s: CrossPointSettings): string {
	return JSON.stringify([s.mode, s.includeImages, s.addTitleHeading, s.author]);
}

export function makeHttp() {
	return async (r: { url: string; method: string; body?: string | ArrayBuffer; contentType?: string; headers?: Record<string, string> }) => {
		const res = await requestUrl({ ...r, throw: false });
		let text = "";
		try { text = res.text; } catch { /* binary or empty */ }
		return { status: res.status, text };
	};
}

export class CrossPointSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: CrossPointPushPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();

		new Setting(containerEl)
			.setName("Reader address")
			.setDesc("Shown on the reader under File Transfer → Join a Network. Use the IP if crosspoint.local doesn't resolve (common on iOS/Android).")
			.addText((t) => t.setPlaceholder("crosspoint.local").setValue(s.host).onChange(async (v) => { s.host = v.trim(); await save(); }))
			.addButton((b) => b.setButtonText("Test").onClick(async () => {
				try {
					const st = await new CrossPointDevice(s.host, makeHttp()).status();
					new Notice(`Connected: ${st.device ?? "reader"} running CrossPoint ${st.version ?? "?"} at ${st.ip ?? s.host}`);
				} catch (e) {
					new Notice(`Couldn't reach the reader: ${(e as Error).message}`, 8000);
				}
			}));

		new Setting(containerEl)
			.setName("Vault folder to push")
			.setDesc("Everything under this folder is converted and sent. Existing .epub/.xtc files in it are sent as-is.")
			.addText((t) => t.setPlaceholder("Reading/To read").setValue(s.sourceFolder).onChange(async (v) => {
				s.sourceFolder = v.trim() ? normalizePath(v.trim()) : "";
				await save();
			}));

		new Setting(containerEl)
			.setName("Folder on the reader")
			.setDesc("Destination on the SD card. Subfolders mirror the vault.")
			.addText((t) => t.setPlaceholder("/Obsidian").setValue(s.destFolder).onChange(async (v) => {
				s.destFolder = "/" + v.trim().replace(/^\/+|\/+$/g, "");
				await save();
			}));

		new Setting(containerEl)
			.setName("Bundling")
			.setDesc("One book per note, or one book per folder with each note as a chapter.")
			.addDropdown((d) => d
				.addOption("per-note", "One EPUB per note")
				.addOption("per-folder", "One EPUB per folder")
				.setValue(s.mode)
				.onChange(async (v) => { s.mode = v as BundleMode; await save(); }));

		new Setting(containerEl)
			.setName("Include images")
			.setDesc("PNG/JPEG are scaled to the screen and re-encoded (CrossPoint can't show progressive JPEGs). Other formats become a text placeholder.")
			.addToggle((t) => t.setValue(s.includeImages).onChange(async (v) => { s.includeImages = v; await save(); }));

		new Setting(containerEl)
			.setName("Add note title as heading")
			.setDesc("Skipped automatically when a note already starts with a # heading.")
			.addToggle((t) => t.setValue(s.addTitleHeading).onChange(async (v) => { s.addTitleHeading = v; await save(); }));

		new Setting(containerEl)
			.setName("Author shown on the reader")
			.addText((t) => t.setPlaceholder("Obsidian").setValue(s.author).onChange(async (v) => { s.author = v; await save(); }));

		new Setting(containerEl)
			.setName("Remove books whose notes are gone")
			.setDesc("Only deletes files this plugin uploaded earlier; nothing else on the card is touched.")
			.addToggle((t) => t.setValue(s.mirrorDeletes).onChange(async (v) => { s.mirrorDeletes = v; await save(); }));

		new Setting(containerEl)
			.setName("Forget upload history")
			.setDesc("Next push re-sends everything.")
			.addButton((b) => b.setButtonText("Reset").setWarning().onClick(async () => {
				await this.plugin.resetState();
				new Notice("CrossPoint upload history cleared.");
			}));
	}
}
