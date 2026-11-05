import { App, DataAdapter, TFile, TFolder, Vault } from "obsidian";
import { buildEpub, Chapter } from "./epub";
import { CrossPointDevice, joinPath, RemoteEntry } from "./device";
import { ImageRegistry, prepareNote, PreparedNote, RENDER_VERSION, renderNote } from "./render";
import { CrossPointSettings, renderSignature } from "./settings";

const PASSTHROUGH = /^(epub|xtc|xtch)$/i;

export interface PushedRecord {
	key: string;   // hash of everything that went into the file
	size: number;  // bytes uploaded
}
export type PushState = Record<string, PushedRecord>; // keyed by remote path

interface Job {
	remote: string;
	title: string;
	notes: TFile[];        // markdown sources (empty for passthrough)
	passthrough?: TFile;   // existing book file sent unchanged
}

export interface PushResult {
	uploaded: string[];
	unchanged: number;
	deleted: string[];
	failed: { remote: string; error: string }[];
}

export type Progress = (msg: string) => void;

// ---------- helpers ----------

export async function sha256(s: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** FAT32-safe file name. */
function safeName(s: string): string {
	const out = s.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "").trim();
	return out || "untitled";
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Folder path of `file` relative to `root` ("" when directly inside it). */
function relDir(file: TFile | TFolder, root: TFolder): string {
	const dir = file instanceof TFile ? file.parent : file;
	if (!dir || dir.path === root.path) return "";
	if (root.isRoot()) return dir.path;
	return dir.path.startsWith(root.path + "/") ? dir.path.slice(root.path.length + 1) : "";
}

function remoteDirFor(dest: string, rel: string): string {
	return joinPath(dest, ...rel.split("/").filter(Boolean).map(safeName));
}

// ---------- planning ----------

/**
 * `root` is the folder remote paths are relative to: the configured source folder
 * when `source` lies inside it, so a partial push lands where a full push would.
 */
export function planJobs(source: TFolder | TFile, root: TFolder, settings: CrossPointSettings): Job[] {
	const dest = joinPath(settings.destFolder || "/");
	const files: TFile[] = [];
	if (source instanceof TFile) files.push(source);
	else Vault.recurseChildren(source, (f) => { if (f instanceof TFile) files.push(f); });

	const jobs: Job[] = [];
	const folders = new Map<string, TFile[]>();

	for (const f of files.sort((a, b) => collator.compare(a.path, b.path))) {
		const rel = relDir(f, root);
		if (PASSTHROUGH.test(f.extension)) {
			jobs.push({ remote: joinPath(remoteDirFor(dest, rel), safeName(f.name)), title: f.basename, notes: [], passthrough: f });
		} else if (f.extension === "md") {
			if (settings.mode === "per-note" || source instanceof TFile) {
				jobs.push({ remote: joinPath(remoteDirFor(dest, rel), safeName(f.basename) + ".epub"), title: f.basename, notes: [f] });
			} else {
				const key = f.parent?.path ?? "/";
				if (!folders.has(key)) folders.set(key, []);
				folders.get(key)!.push(f);
			}
		}
	}

	for (const [, notes] of folders) {
		const folder = notes[0].parent!;
		const name = folder.isRoot() ? "Vault" : folder.name;
		// The folder's book sits beside where the folder would be: /dest/<parent rel>/<Folder>.epub
		const relParent = folder.path === root.path || !folder.parent ? "" : relDir(folder.parent, root);
		jobs.push({ remote: joinPath(remoteDirFor(dest, relParent), safeName(name) + ".epub"), title: name, notes });
	}

	// Two sources can map to the same remote name (e.g. "a:b" and "a?b"); keep the first.
	const seen = new Set<string>();
	return jobs.filter((j) => (seen.has(j.remote.toLowerCase()) ? false : (seen.add(j.remote.toLowerCase()), true)));
}

// ---------- building ----------

function startsWithH1(md: string): boolean {
	return /^\s*#\s+\S/.test(md);
}

async function buildBook(app: App, job: Job, prepared: PreparedNote[], settings: CrossPointSettings, uid: string): Promise<Uint8Array> {
	const registry = new ImageRegistry(app);
	const ids = new Map<string, string>(prepared.map((p, i) => [p.file.path, `ch${String(i + 1).padStart(3, "0")}`]));
	const chapters: Chapter[] = [];

	for (const p of prepared) {
		const body = await renderNote(
			app,
			p,
			// Links between chapters of the same book work; links to other books can't.
			(target) => (ids.has(target.path) && target.path !== p.file.path ? `${ids.get(target.path)}.xhtml` : null),
			registry,
			settings.addTitleHeading && !startsWithH1(p.markdown),
		);
		chapters.push({ id: ids.get(p.file.path)!, title: p.title, xhtmlBody: body });
	}

	return buildEpub({
		uid,
		title: prepared.length === 1 ? prepared[0].title : job.title,
		author: settings.author || undefined,
		chapters,
		resources: registry.resources,
	});
}

// ---------- push ----------

export class Pusher {
	constructor(
		private app: App,
		private device: CrossPointDevice,
		private settings: CrossPointSettings,
		private state: PushState,
		private cacheDir: string,
		private progress: Progress,
	) {}

	private get fs(): DataAdapter {
		return this.app.vault.adapter;
	}

	private async cachePath(remote: string) {
		return `${this.cacheDir}/${(await sha256(remote)).slice(0, 24)}.epub`;
	}

	private remoteDirs = new Map<string, RemoteEntry[] | null>();
	private async remoteEntry(remote: string): Promise<RemoteEntry | undefined> {
		const dir = remote.substring(0, remote.lastIndexOf("/")) || "/";
		if (!this.remoteDirs.has(dir)) this.remoteDirs.set(dir, await this.device.list(dir));
		const name = remote.slice(remote.lastIndexOf("/") + 1);
		return this.remoteDirs.get(dir)?.find((e) => !e.isDirectory && e.name === name);
	}

	/** Produces the bytes for a job, reusing the cached EPUB when sources are unchanged. */
	private async materialise(job: Job): Promise<{ key: string; bytes: () => Promise<Uint8Array> }> {
		if (job.passthrough) {
			const f = job.passthrough;
			return { key: await sha256(`raw:${f.path}@${f.stat.mtime}:${f.stat.size}`), bytes: async () => new Uint8Array(await this.app.vault.readBinary(f)) };
		}
		const prepared: PreparedNote[] = [];
		for (const n of job.notes) prepared.push(await prepareNote(this.app, n, { includeImages: this.settings.includeImages }));
		const key = await sha256(JSON.stringify([RENDER_VERSION, renderSignature(this.settings), job.remote, prepared.flatMap((p) => p.deps)]));
		const cache = await this.cachePath(job.remote);
		const prev = this.state[job.remote];

		return {
			key,
			bytes: async () => {
				if (prev?.key === key && (await this.fs.exists(cache))) {
					return new Uint8Array(await this.fs.readBinary(cache));
				}
				this.progress(`Converting ${job.title}…`);
				const data = await buildBook(this.app, job, prepared, this.settings, `urn:obsidian-crosspoint:${(await sha256(job.remote)).slice(0, 32)}`);
				if (!(await this.fs.exists(this.cacheDir))) await this.fs.mkdir(this.cacheDir);
				await this.fs.writeBinary(cache, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
				return data;
			},
		};
	}

	async push(jobs: Job[], scopeDest: string | null): Promise<PushResult> {
		const res: PushResult = { uploaded: [], unchanged: 0, deleted: [], failed: [] };
		const ensured = new Set<string>();

		for (const [i, job] of jobs.entries()) {
			try {
				this.progress(`(${i + 1}/${jobs.length}) Checking ${job.title}…`);
				const { key, bytes } = await this.materialise(job);
				const prev = this.state[job.remote];
				const remote = await this.remoteEntry(job.remote);

				if (prev && prev.key === key && remote && remote.size === prev.size) {
					res.unchanged++;
					continue;
				}

				const data = await bytes();
				const dir = job.remote.substring(0, job.remote.lastIndexOf("/")) || "/";
				if (!ensured.has(dir)) {
					await this.device.ensureDir(dir);
					ensured.add(dir);
				}
				this.progress(`(${i + 1}/${jobs.length}) Uploading ${job.title} (${Math.ceil(data.byteLength / 1024)} KB)…`);
				await this.device.put(job.remote, data);
				this.state[job.remote] = { key, size: data.byteLength };
				res.uploaded.push(job.remote);
			} catch (e) {
				res.failed.push({ remote: job.remote, error: (e as Error).message });
			}
		}

		// Remove books this plugin uploaded earlier whose sources are gone.
		if (this.settings.mirrorDeletes && scopeDest !== null) {
			const live = new Set(jobs.map((j) => j.remote));
			const prefix = scopeDest === "/" ? "/" : scopeDest + "/";
			for (const remote of Object.keys(this.state)) {
				if (live.has(remote) || !remote.startsWith(prefix)) continue;
				try {
					this.progress(`Removing ${remote}…`);
					await this.device.remove(remote);
					delete this.state[remote];
					const cache = await this.cachePath(remote);
					if (await this.fs.exists(cache)) await this.fs.remove(cache);
					res.deleted.push(remote);
				} catch (e) {
					res.failed.push({ remote, error: (e as Error).message });
				}
			}
		}
		return res;
	}
}
