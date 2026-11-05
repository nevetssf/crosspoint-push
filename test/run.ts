import * as fs from "node:fs";
import * as path from "node:path";
import { strict as assert } from "node:assert";
import { buildEpub } from "../src/epub";
import { CrossPointDevice, HttpFn } from "../src/device";
import { planJobs, Pusher, PushState } from "../src/sync";
import { DEFAULT_SETTINGS } from "../src/settings";
import { FakeVaultBuilder, TFolder } from "obsidian";

const [, , host, sdDir, workDir] = process.argv;

const http: HttpFn = async (r) => {
	const res = await fetch(r.url, {
		method: r.method,
		body: r.body as BodyInit | undefined,
		headers: r.contentType ? { "Content-Type": r.contentType } : undefined,
	});
	return { status: res.status, text: await res.text() };
};

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
	await fn();
	passed++;
	console.log(`  ok  ${name}`);
}

// 1x1 PNG
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64"));

async function main() {
	const device = new CrossPointDevice(host, http);

	await test("EPUB builds, is deterministic, and is written for epubcheck", async () => {
		const spec = {
			uid: "urn:test:1",
			title: "Notes & <Things>",
			chapters: [
				{ id: "ch001", title: "First", xhtmlBody: `<h1>First</h1>\n<p>Hello <strong>world</strong> &amp; café — “quotes”</p>\n<blockquote class="callout"><p class="callout-title">Note</p><p>Inside</p></blockquote>\n<p><img src="images/img001.png" alt="dot.png"/></p>\n<p><a href="ch002.xhtml">Second</a> [x] done</p>\n<pre><code>x = 1 &lt; 2</code></pre>` },
				{ id: "ch002", title: "Second", xhtmlBody: `<h1>Second</h1><ul><li>one</li><li>two</li></ul><table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>` },
			],
			resources: [{ href: "images/img001.png", mediaType: "image/png", data: PNG }],
		};
		const a = await buildEpub(spec);
		const b = await buildEpub(spec);
		assert.deepEqual(Buffer.from(a), Buffer.from(b), "identical input must give identical bytes");
		assert.equal(Buffer.from(a.subarray(30, 38)).toString(), "mimetype", "mimetype must be the first zip entry");
		assert.equal(Buffer.from(a.subarray(38, 58)).toString(), "application/epub+zip", "mimetype must be stored uncompressed");
		fs.writeFileSync(path.join(workDir, "sample.epub"), a);
	});

	await test("device: status, mkdir -p, put, list, delete", async () => {
		const st = await device.status();
		assert.equal(st.device, "X4");
		await device.ensureDir("/Obsidian/Deep/Nested Dir");
		await device.ensureDir("/Obsidian/Deep"); // already exists → no error
		await device.put("/Obsidian/Deep/Nested Dir/a b#c.epub", new Uint8Array([1, 2, 3]));
		const ls = await device.list("/Obsidian/Deep/Nested Dir");
		assert.deepEqual(ls?.map((e) => [e.name, e.size]), [["a b#c.epub", 3]]);
		assert.equal(await device.list("/missing"), null);
		await device.remove("/Obsidian/Deep/Nested Dir/a b#c.epub");
		assert.deepEqual(await device.list("/Obsidian/Deep/Nested Dir"), []);
		await device.remove("/Obsidian/Deep/Nested Dir/nothing.epub"); // 404 tolerated
	});

	await test("device: unreachable host fails fast with a clear message", async () => {
		const dead = new CrossPointDevice("127.0.0.1:1", http);
		await assert.rejects(dead.status(), /Reaching the reader/);
	});

	const vb = new FakeVaultBuilder();
	vb.file("Reading/Intro.md", "# Intro");
	vb.file("Reading/Papers/LVI: notes?.md", "x");
	vb.file("Reading/Papers/Second.md", "y");
	vb.file("Reading/Books/Existing.epub", new Uint8Array(5000).fill(7), 10);
	vb.file("Elsewhere/Other.md", "z");
	const root = vb.folder("Reading");

	await test("planJobs per-note: mirrors folders, sanitises FAT names, passes books through", async () => {
		const jobs = planJobs(root, root, DEFAULT_SETTINGS);
		assert.deepEqual(jobs.map((j) => j.remote).sort(), [
			"/Obsidian/Books/Existing.epub",
			"/Obsidian/Intro.epub",
			"/Obsidian/Papers/LVI_ notes_.epub",
			"/Obsidian/Papers/Second.epub",
		]);
	});

	await test("planJobs per-folder: one book per folder, notes as chapters in natural order", async () => {
		const jobs = planJobs(root, root, { ...DEFAULT_SETTINGS, mode: "per-folder" });
		const m = Object.fromEntries(jobs.map((j) => [j.remote, j.notes.map((n) => n.name)]));
		assert.deepEqual(m, {
			"/Obsidian/Books/Existing.epub": [],
			"/Obsidian/Reading.epub": ["Intro.md"],
			"/Obsidian/Papers.epub": ["LVI: notes?.md", "Second.md"],
		});
	});

	await test("planJobs on a subfolder keeps the same remote layout as a full push", async () => {
		const sub = vb.folder("Reading/Papers");
		const jobs = planJobs(sub, root, DEFAULT_SETTINGS);
		assert.deepEqual(jobs.map((j) => j.remote).sort(), ["/Obsidian/Papers/LVI_ notes_.epub", "/Obsidian/Papers/Second.epub"]);
	});

	await test("Pusher: uploads, skips unchanged, re-sends on change or when missing, mirrors deletes", async () => {
		const books = new FakeVaultBuilder();
		books.file("Lib/A.epub", new Uint8Array(1000).fill(1), 1);
		books.file("Lib/Sub/B.epub", new Uint8Array(2000).fill(2), 1);
		const lib = books.folder("Lib");
		const cache = path.join(workDir, "adapter");
		fs.mkdirSync(cache, { recursive: true });
		const app = books.app(cache) as any;
		const state: PushState = {};
		const settings = { ...DEFAULT_SETTINGS, destFolder: "/Lib", mirrorDeletes: true };
		const run = () => new Pusher(app, device, settings, state, "cache", () => {}).push(planJobs(lib, lib, settings), "/Lib");

		let r = await run();
		assert.deepEqual([r.uploaded.length, r.unchanged, r.failed], [2, 0, []]);
		assert.equal(fs.statSync(path.join(sdDir, "Lib/Sub/B.epub")).size, 2000);

		r = await run();
		assert.deepEqual([r.uploaded.length, r.unchanged], [0, 2], "second run should upload nothing");

		books.file("Lib/A.epub", new Uint8Array(1100).fill(3), 2); // edited
		fs.rmSync(path.join(sdDir, "Lib/Sub/B.epub"));               // deleted on the reader
		r = await run();
		assert.deepEqual(r.uploaded.sort(), ["/Lib/A.epub", "/Lib/Sub/B.epub"]);

		fs.writeFileSync(path.join(sdDir, "Lib/NotOurs.epub"), "x");  // user's own file
		books.removeFile("Lib/Sub/B.epub");
		r = await run();
		assert.deepEqual(r.deleted, ["/Lib/Sub/B.epub"]);
		assert.ok(fs.existsSync(path.join(sdDir, "Lib/NotOurs.epub")), "files we never uploaded are never deleted");
		assert.ok(!("/Lib/Sub/B.epub" in state));
	});

	console.log(`\n${passed} tests passed`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
