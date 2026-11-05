// npm test: starts the mock reader, bundles the tests with a fake `obsidian`, runs them.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import esbuild from "esbuild";

const work = mkdtempSync(join(process.env.TEST_TMP ?? tmpdir(), "cp-test-"));
const sd = join(work, "sd");
mkdirSync(sd);
const port = 18000 + Math.floor(Math.random() * 1000);

await esbuild.build({
	entryPoints: ["test/run.ts"], bundle: true, platform: "node", format: "esm",
	outfile: join(work, "run.mjs"), alias: { obsidian: "./test/fake-obsidian.ts" }, logLevel: "warning",
});

const server = spawn("python3", ["test/mock_crosspoint.py", sd, String(port)], { stdio: "inherit" });
await new Promise((r) => setTimeout(r, 700));
try {
	execFileSync("node", [join(work, "run.mjs"), `127.0.0.1:${port}`, sd, work], { stdio: "inherit" });
	console.log(`work dir: ${work}`);
} finally {
	server.kill();
}
