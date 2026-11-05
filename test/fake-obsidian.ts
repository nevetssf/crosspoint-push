// Just enough of the Obsidian API to exercise planning, change detection and
// uploading outside the app. Rendering is not covered here (it needs Obsidian).
import * as nodefs from "node:fs";
import * as nodepath from "node:path";

export abstract class TAbstractFile {
	parent: TFolder | null = null;
	constructor(public path: string, public name: string) {}
}
export class TFile extends TAbstractFile {
	stat = { mtime: 1, ctime: 1, size: 0 };
	get basename() { return this.name.replace(/\.[^.]+$/, ""); }
	get extension() { return this.name.includes(".") ? this.name.split(".").pop()! : ""; }
}
export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
	isRoot() { return this.path === "/"; }
}
export class Vault {
	static recurseChildren(root: TFolder, cb: (f: TAbstractFile) => unknown) {
		cb(root);
		for (const c of root.children) c instanceof TFolder ? Vault.recurseChildren(c, cb) : cb(c);
	}
}
export class Component { load() {} unload() {} }
export const MarkdownRenderer = { render: async () => { throw new Error("not in tests"); } };
export function getFrontMatterInfo(_: string) { return { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 }; }
export function normalizePath(p: string) { return p; }
export class Notice {}
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export async function requestUrl() { throw new Error("not in tests"); }

/** In-memory vault whose binary contents live in a map; adapter writes to a real dir. */
export class FakeVaultBuilder {
	root = new TFolder("/", "");
	data = new Map<string, Uint8Array>();
	private byPath = new Map<string, TAbstractFile>([["/", this.root]]);

	folder(path: string): TFolder {
		if (this.byPath.has(path)) return this.byPath.get(path) as TFolder;
		const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/";
		const parent = this.folder(parentPath);
		const f = new TFolder(path, path.split("/").pop()!);
		f.parent = parent;
		parent.children.push(f);
		this.byPath.set(path, f);
		return f;
	}
	file(path: string, content: string | Uint8Array, mtime = 1): TFile {
		const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/";
		const parent = this.folder(parentPath);
		let f = this.byPath.get(path) as TFile | undefined;
		if (!f) {
			f = new TFile(path, path.split("/").pop()!);
			f.parent = parent;
			parent.children.push(f);
			this.byPath.set(path, f);
		}
		const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
		this.data.set(path, bytes);
		f.stat = { mtime, ctime: 1, size: bytes.byteLength };
		return f;
	}
	removeFile(path: string) {
		const f = this.byPath.get(path)!;
		f.parent!.children = f.parent!.children.filter((c) => c !== f);
		this.byPath.delete(path);
	}
	app(adapterDir: string) {
		const abs = (p: string) => nodepath.join(adapterDir, p);
		return {
			vault: {
				readBinary: async (f: TFile) => this.data.get(f.path)!.slice().buffer,
				cachedRead: async (f: TFile) => new TextDecoder().decode(this.data.get(f.path)),
				getAbstractFileByPath: (p: string) => this.byPath.get(p) ?? null,
				adapter: {
					exists: async (p: string) => nodefs.existsSync(abs(p)),
					mkdir: async (p: string) => void nodefs.mkdirSync(abs(p), { recursive: true }),
					readBinary: async (p: string) => new Uint8Array(nodefs.readFileSync(abs(p))).buffer,
					writeBinary: async (p: string, d: ArrayBuffer) => nodefs.writeFileSync(abs(p), new Uint8Array(d)),
					remove: async (p: string) => nodefs.rmSync(abs(p)),
				},
			},
			metadataCache: { getFirstLinkpathDest: () => null, getFileCache: () => null },
		};
	}
}
