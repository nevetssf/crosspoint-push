import { Notice, Plugin, TAbstractFile, TFile, TFolder } from "obsidian";
import { CrossPointDevice, joinPath } from "./device";
import { CrossPointSettings, CrossPointSettingTab, DEFAULT_SETTINGS, makeHttp } from "./settings";
import { planJobs, Pusher, PushState } from "./sync";

interface PluginData {
	settings: CrossPointSettings;
	state: PushState;
}

export default class CrossPointPushPlugin extends Plugin {
	settings: CrossPointSettings = { ...DEFAULT_SETTINGS };
	state: PushState = {};
	private running = false;

	async onload() {
		const data = (await this.loadData()) as Partial<PluginData> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(data?.settings ?? {}) };
		this.state = data?.state ?? {};

		this.addSettingTab(new CrossPointSettingTab(this.app, this));

		this.addRibbonIcon("book-up", "Push to CrossPoint reader", () => this.pushConfigured());

		this.addCommand({
			id: "push-folder",
			name: "Push configured folder to reader",
			callback: () => this.pushConfigured(),
		});

		this.addCommand({
			id: "push-current-note",
			name: "Push current note to reader",
			checkCallback: (checking) => {
				const f = this.app.workspace.getActiveFile();
				if (!f || f.extension !== "md") return false;
				if (!checking) void this.push(f, false);
				return true;
			},
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file: TAbstractFile) => {
				const ok = file instanceof TFolder || (file instanceof TFile && /^(md|epub|xtc|xtch)$/.test(file.extension));
				if (!ok) return;
				menu.addItem((item) =>
					item.setTitle("Push to CrossPoint reader").setIcon("book-up").onClick(() => this.push(file as TFile | TFolder, false)),
				);
			}),
		);
	}

	async saveSettings() {
		await this.saveData({ settings: this.settings, state: this.state } satisfies PluginData);
	}

	async resetState() {
		this.state = {};
		await this.saveSettings();
		const dir = this.cacheDir();
		if (await this.app.vault.adapter.exists(dir)) await this.app.vault.adapter.rmdir(dir, true);
	}

	private cacheDir() {
		return `${this.manifest.dir}/cache`;
	}

	private configuredRoot(): TFolder | null {
		const p = this.settings.sourceFolder;
		if (!p) return null;
		const f = this.app.vault.getAbstractFileByPath(p);
		return f instanceof TFolder ? f : null;
	}

	private pushConfigured() {
		const root = this.configuredRoot();
		if (!root) {
			new Notice(this.settings.sourceFolder
				? `Folder "${this.settings.sourceFolder}" not found. Check the CrossPoint settings.`
				: "Set the vault folder to push in Settings → CrossPoint Push.");
			return;
		}
		void this.push(root, true);
	}

	/** Remote paths are relative to the configured folder when the target is inside it. */
	private rootFor(target: TFile | TFolder): TFolder {
		const cfg = this.configuredRoot();
		if (cfg && (cfg.isRoot() || target.path === cfg.path || target.path.startsWith(cfg.path + "/"))) return cfg;
		return target.parent ?? this.app.vault.getRoot();
	}

	async push(target: TFile | TFolder, fullSync: boolean) {
		if (this.running) {
			new Notice("A push to the reader is already running.");
			return;
		}
		this.running = true;
		const notice = new Notice("Connecting to the reader…", 0);
		const progress = (m: string) => notice.setMessage(m);

		try {
			const device = new CrossPointDevice(this.settings.host, makeHttp());
			device.onRetry = (what, attempt) => progress(`${what}… retrying (attempt ${attempt})`);
			try {
				await device.status();
			} catch (e) {
				notice.setMessage(
					`Can't reach the reader at ${this.settings.host}.\nOn the reader: File Transfer → Join a Network, then try again.\n(${(e as Error).message})`,
				);
				setTimeout(() => notice.hide(), 10000);
				return;
			}

			const jobs = planJobs(target, this.rootFor(target), this.settings);
			if (jobs.length === 0) {
				notice.setMessage("Nothing to push: no notes or books found there.");
				setTimeout(() => notice.hide(), 5000);
				return;
			}

			const pusher = new Pusher(this.app, device, this.settings, this.state, this.cacheDir(), progress);
			const res = await pusher.push(jobs, fullSync ? joinPath(this.settings.destFolder || "/") : null);
			await this.saveSettings();

			const lines = [
				`Reader: ${res.uploaded.length} sent, ${res.unchanged} unchanged` + (res.deleted.length ? `, ${res.deleted.length} removed` : ""),
			];
			for (const f of res.failed.slice(0, 5)) lines.push(`✗ ${f.remote}: ${f.error}`);
			if (res.failed.length > 5) lines.push(`…and ${res.failed.length - 5} more failures (see console)`);
			if (res.failed.length) console.warn("[crosspoint-push] failures", res.failed);
			notice.setMessage(lines.join("\n"));
			setTimeout(() => notice.hide(), res.failed.length ? 15000 : 5000);
		} catch (e) {
			console.error("[crosspoint-push]", e);
			notice.setMessage(`Push failed: ${(e as Error).message}`);
			setTimeout(() => notice.hide(), 10000);
		} finally {
			this.running = false;
		}
	}
}
