// Markdown → XHTML using Obsidian's own renderer, then cleaned up for an
// e-ink EPUB reader (no SVG, no JS, no interactive bits, ASCII-safe glyphs).
import { App, Component, MarkdownRenderer, TFile, getFrontMatterInfo } from "obsidian";
import type { Resource } from "./epub";

/** Bump when rendering output changes, so cached EPUBs are rebuilt. */
export const RENDER_VERSION = 3;

const IMG_TOKEN = (i: number) => `@@CPIMG${i}@@`;
const IMG_TOKEN_RE = /@@CPIMG(\d+)@@/g;
const MAX_EMBED_DEPTH = 3;
const MAX_IMAGE_EDGE = 800; // X4 is 480x800; X3 is 528x792

export interface PreparedNote {
	file: TFile;
	title: string;
	markdown: string;
	/** Vault paths of images, indexed by token number (null = unresolvable). */
	images: (string | null)[];
	/** Every file whose content affects the output, as "path@mtime". */
	deps: string[];
}

export interface RenderOptions {
	includeImages: boolean;
}

// ---------- preparation (pure markdown work) ----------

function stripFrontmatter(text: string): { body: string; fm: string } {
	const info = getFrontMatterInfo(text);
	return info.exists
		? { body: text.slice(info.contentStart), fm: info.frontmatter }
		: { body: text, fm: "" };
}

function fmTitle(fm: string): string | null {
	const m = fm.match(/^title:\s*(.+)$/m);
	if (!m) return null;
	return m[1].trim().replace(/^["']|["']$/g, "") || null;
}

/** Slice a note to a heading section or block for `![[Note#Heading]]` / `![[Note#^block]]`. */
function sliceSubpath(app: App, file: TFile, body: string, full: string, subpath: string): string {
	const cache = app.metadataCache.getFileCache(file);
	if (!cache) return body;
	if (subpath.startsWith("^")) {
		const block = cache.blocks?.[subpath.slice(1)];
		if (!block) return body;
		return full.slice(block.position.start.offset, block.position.end.offset).replace(/\s\^[\w-]+\s*$/, "");
	}
	const want = subpath.toLowerCase().trim();
	const hs = cache.headings ?? [];
	const i = hs.findIndex((h) => h.heading.toLowerCase().trim() === want);
	if (i < 0) return body;
	const start = hs[i].position.start.offset;
	const next = hs.slice(i + 1).find((h) => h.level <= hs[i].level);
	return full.slice(start, next ? next.position.start.offset : undefined);
}

function protectMath(md: string): string {
	// Rendered math becomes SVG we can't use; show the TeX source as code instead.
	md = md.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex) => "\n```text\n" + String(tex).trim() + "\n```\n");
	md = md.replace(/(^|[^\\$\w])\$(?=\S)([^$\n]+?)(?<=\S)\$(?!\d)/g, (_m, pre, tex) => `${pre}\`${tex}\``);
	return md;
}

function protectDiagrams(md: string): string {
	// Mermaid renders to SVG; keep the source readable instead of dropping it.
	return md.replace(/^(\s*)(```+|~~~+)\s*mermaid\s*$/gim, "$1$2text");
}

export async function prepareNote(app: App, file: TFile, opts: RenderOptions): Promise<PreparedNote> {
	const images: (string | null)[] = [];
	const deps = new Set<string>();

	const expand = async (f: TFile, depth: number, stack: Set<string>, subpath?: string): Promise<string> => {
		deps.add(`${f.path}@${f.stat.mtime}`);
		const full = await app.vault.cachedRead(f);
		let { body } = stripFrontmatter(full);
		if (subpath) body = sliceSubpath(app, f, body, full, subpath);

		const parts: string[] = [];
		let last = 0;
		// ![[target|alias]]  or  ![alt](path "title")
		const re = /!\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]|!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(body))) {
			parts.push(body.slice(last, m.index));
			last = re.lastIndex;
			const isWiki = m[1] !== undefined;
			const rawTarget = isWiki ? m[1] : decodeURIComponent(m[4]);
			const alt = (isWiki ? m[2] : m[3]) ?? "";

			if (/^[a-z]+:\/\//i.test(rawTarget)) {
				parts.push(alt ? `*[image: ${alt}]*` : "");
				continue;
			}
			const [linkpath, sub] = rawTarget.split("#", 2);
			const dest = app.metadataCache.getFirstLinkpathDest(linkpath.trim(), f.path);

			if (dest && dest.extension === "md") {
				if (depth >= MAX_EMBED_DEPTH || stack.has(dest.path)) {
					parts.push(`*[${dest.basename}]*`);
				} else {
					const inner = await expand(dest, depth + 1, new Set([...stack, dest.path]), sub);
					parts.push(`\n\n${inner.trim()}\n\n`);
				}
			} else if (dest && /^(png|jpe?g)$/i.test(dest.extension) && opts.includeImages) {
				deps.add(`${dest.path}@${dest.stat.mtime}`);
				images.push(dest.path);
				parts.push(`\n\n${IMG_TOKEN(images.length - 1)}\n\n`);
			} else {
				const label = alt && !/^\d+(x\d+)?$/.test(alt) ? alt : (dest?.name ?? linkpath);
				parts.push(`*[${dest && /^(png|jpe?g|gif|webp|svg|bmp)$/i.test(dest.extension) ? "image" : "embed"}: ${label}]*`);
			}
		}
		parts.push(body.slice(last));
		return parts.join("");
	};

	const full = await app.vault.cachedRead(file);
	const title = fmTitle(stripFrontmatter(full).fm) ?? file.basename;
	let md = await expand(file, 0, new Set([file.path]));
	md = protectDiagrams(protectMath(md));
	return { file, title, markdown: md, images, deps: [...deps].sort() };
}

// ---------- images ----------

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };

async function toBlob(canvas: HTMLCanvasElement, type: string, q?: number): Promise<Blob | null> {
	return new Promise((res) => canvas.toBlob((b) => res(b), type, q));
}

/**
 * Downscale to the screen size and re-encode. JPEGs are always re-encoded,
 * because CrossPoint can't decode progressive JPEGs and the canvas encoder
 * always writes baseline.
 */
async function normaliseImage(data: ArrayBuffer, ext: string): Promise<{ data: Uint8Array; ext: string }> {
	const isJpeg = ext !== "png";
	try {
		const bmp = await createImageBitmap(new Blob([data]));
		const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bmp.width, bmp.height));
		if (scale === 1 && !isJpeg) {
			bmp.close();
			return { data: new Uint8Array(data), ext };
		}
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(bmp.width * scale));
		canvas.height = Math.max(1, Math.round(bmp.height * scale));
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("no 2d context");
		ctx.fillStyle = "#fff"; // flatten transparency onto white paper
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
		bmp.close();
		const outType = isJpeg ? "image/jpeg" : "image/png";
		const blob = await toBlob(canvas, outType, isJpeg ? 0.85 : undefined);
		if (!blob) throw new Error("encode failed");
		return { data: new Uint8Array(await blob.arrayBuffer()), ext: isJpeg ? "jpg" : "png" };
	} catch {
		return { data: new Uint8Array(data), ext };
	}
}

/** Shares images across the chapters of one EPUB, deduplicated by vault path. */
export class ImageRegistry {
	readonly resources: Resource[] = [];
	private byPath = new Map<string, string | null>();

	constructor(private app: App) {}

	async add(vaultPath: string): Promise<string | null> {
		if (this.byPath.has(vaultPath)) return this.byPath.get(vaultPath)!;
		const f = this.app.vault.getAbstractFileByPath(vaultPath);
		let href: string | null = null;
		if (f instanceof TFile) {
			const ext = f.extension.toLowerCase();
			if (MIME[ext]) {
				const norm = await normaliseImage(await this.app.vault.readBinary(f), ext);
				href = `images/img${String(this.resources.length + 1).padStart(3, "0")}.${norm.ext}`;
				this.resources.push({ href, mediaType: MIME[norm.ext], data: norm.data });
			}
		}
		this.byPath.set(vaultPath, href);
		return href;
	}
}

// ---------- render + clean ----------

/** Returns an href for a link to another note, or null to drop the link and keep its text. */
export type LinkResolver = (target: TFile, subpath: string | null) => string | null;

const DROP_SELECTORS = [
	"svg", "button", "script", "style", "iframe", "video", "audio", "object", "embed", "canvas",
	"mjx-container", ".copy-code-button", ".collapse-indicator", ".heading-collapse-indicator",
	".callout-icon", ".callout-fold", ".frontmatter", ".frontmatter-container", ".metadata-container",
	".edit-block-button", ".markdown-embed-link", ".list-bullet", ".mod-header", ".mod-footer",
].join(",");

const KEEP_ATTRS = new Set(["href", "src", "alt", "id", "class", "colspan", "rowspan", "start", "title"]);

function unwrap(el: Element) {
	const parent = el.parentNode;
	if (!parent) return;
	while (el.firstChild) parent.insertBefore(el.firstChild, el);
	parent.removeChild(el);
}

function cleanTree(root: HTMLElement, resolve: LinkResolver, app: App, sourcePath: string) {
	root.querySelectorAll(DROP_SELECTORS).forEach((e) => e.remove());

	// Callouts → blockquote with a bold title line.
	root.querySelectorAll("div.callout").forEach((c) => {
		const bq = document.createElement("blockquote");
		bq.className = "callout";
		const title = c.querySelector(".callout-title-inner")?.textContent?.trim()
			|| (c.getAttribute("data-callout") ?? "").replace(/^\w/, (s) => s.toUpperCase());
		if (title) {
			const p = document.createElement("p");
			p.className = "callout-title";
			p.textContent = title;
			bq.appendChild(p);
		}
		const content = c.querySelector(".callout-content");
		if (content) while (content.firstChild) bq.appendChild(content.firstChild);
		c.replaceWith(bq);
	});

	// Task checkboxes → ASCII (built-in reader fonts may lack ☐/☑).
	root.querySelectorAll("input").forEach((i) => {
		const checked = (i as HTMLInputElement).checked || i.hasAttribute("checked");
		i.replaceWith(document.createTextNode(checked ? "[x] " : "[ ] "));
	});

	// Links.
	root.querySelectorAll("a").forEach((a) => {
		const href = a.getAttribute("href") ?? "";
		if (a.classList.contains("internal-link")) {
			const target = a.getAttribute("data-href") ?? href;
			const [linkpath, sub] = target.split("#", 2);
			const dest = linkpath ? app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath) : null;
			const resolved = dest ? resolve(dest, sub ?? null) : null;
			if (resolved) a.setAttribute("href", resolved);
			else unwrap(a);
		} else if (a.classList.contains("footnote-backref")) {
			a.textContent = "[back]";
		} else if (!href.startsWith("#")) {
			unwrap(a); // external links, tags: keep the text only
		}
	});

	// Strip noisy attributes.
	root.querySelectorAll("*").forEach((el) => {
		for (const attr of Array.from(el.attributes)) {
			if (!KEEP_ATTRS.has(attr.name)) el.removeAttribute(attr.name);
		}
	});
	// Empty wrappers left behind by removed widgets.
	root.querySelectorAll("div:empty, span:empty").forEach((e) => e.remove());
}

async function insertImages(root: HTMLElement, prepared: PreparedNote, registry: ImageRegistry) {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const hits: Text[] = [];
	while (walker.nextNode()) {
		const t = walker.currentNode as Text;
		if (t.data.includes("@@CPIMG")) hits.push(t);
	}
	for (const t of hits) {
		const frag = document.createDocumentFragment();
		let last = 0;
		for (const m of t.data.matchAll(IMG_TOKEN_RE)) {
			frag.append(t.data.slice(last, m.index));
			last = m.index! + m[0].length;
			const path = prepared.images[Number(m[1])];
			const href = path ? await registry.add(path) : null;
			if (href) {
				const img = document.createElement("img");
				img.setAttribute("src", href);
				img.setAttribute("alt", path!.split("/").pop() ?? "");
				frag.append(img);
			}
		}
		frag.append(t.data.slice(last));
		t.replaceWith(frag);
	}
}

export async function renderNote(
	app: App,
	prepared: PreparedNote,
	resolve: LinkResolver,
	registry: ImageRegistry,
	headingTitle: boolean,
): Promise<string> {
	const root = document.createElement("div");
	const comp = new Component();
	comp.load();
	try {
		await MarkdownRenderer.render(app, prepared.markdown, root, prepared.file.path, comp);
		// Let post-processors that resolve on the next tick settle.
		await new Promise((r) => setTimeout(r, 50));
		cleanTree(root, resolve, app, prepared.file.path);
		await insertImages(root, prepared, registry);

		const ser = new XMLSerializer();
		let out = Array.from(root.childNodes)
			.map((n) => ser.serializeToString(n))
			.join("\n")
			// Each top-level node carries the XHTML namespace already declared on <html>.
			.replace(/ xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/g, "");
		if (headingTitle) {
			const h = document.createElement("h1");
			h.textContent = prepared.title;
			out = ser.serializeToString(h).replace(/ xmlns="[^"]*"/, "") + "\n" + out;
		}
		return out;
	} finally {
		comp.unload();
	}
}
