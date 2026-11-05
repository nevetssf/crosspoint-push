// Client for the CrossPoint File Transfer web server.
// HTTP is injected so this module runs both inside Obsidian (requestUrl,
// which bypasses CORS) and in Node tests (fetch).

export interface HttpRequest {
	url: string;
	method: string;
	body?: string | ArrayBuffer;
	contentType?: string;
	headers?: Record<string, string>;
}
export interface HttpResponse {
	status: number;
	text: string;
}
export type HttpFn = (req: HttpRequest) => Promise<HttpResponse>;

export interface RemoteEntry {
	name: string;
	size: number;
	isDirectory: boolean;
}

export interface DeviceStatus {
	version?: string;
	ip?: string;
	device?: string;
	mode?: string;
}

export class DeviceError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new DeviceError(`${what} timed out after ${ms / 1000}s`)), ms);
		p.then(
			(v) => { clearTimeout(t); resolve(v); },
			(e) => { clearTimeout(t); reject(e); },
		);
	});
}

/** Join and normalise device paths: always absolute, no trailing slash (except root). */
export function joinPath(...parts: string[]): string {
	const segs = parts
		.join("/")
		.split("/")
		.filter((s) => s.length > 0 && s !== ".");
	return "/" + segs.join("/");
}

function encodePath(p: string): string {
	return joinPath(p)
		.split("/")
		.map((s) => encodeURIComponent(s))
		.join("/");
}

export class CrossPointDevice {
	readonly base: string;

	/** Called before each retry, e.g. to update a progress notice. */
	onRetry: (what: string, attempt: number) => void = () => {};

	constructor(host: string, private http: HttpFn, private timeoutMs = 15000) {
		let h = host.trim().replace(/\/+$/, "");
		if (!/^https?:\/\//i.test(h)) h = "http://" + h;
		this.base = h;
	}

	private async once(r: HttpRequest, what: string, timeout: number): Promise<HttpResponse> {
		try {
			return await withTimeout(this.http(r), timeout, what);
		} catch (e) {
			if (e instanceof DeviceError) throw e;
			throw new DeviceError(`${what} failed: ${(e as Error).message ?? e}`);
		}
	}

	/**
	 * Every request this client makes is safe to repeat (PUT replaces atomically,
	 * MKCOL and DELETE tolerate "already done"), so transport failures and
	 * timeouts are retried. HTTP error statuses are not: those are real answers.
	 */
	private async req(r: HttpRequest, what: string, timeout = this.timeoutMs, timeouts?: number[]): Promise<HttpResponse> {
		const plan = timeouts ?? [timeout, timeout, timeout];
		let lastErr: unknown;
		for (const [i, t] of plan.entries()) {
			if (i > 0) {
				this.onRetry(what, i + 1);
				await new Promise((res) => setTimeout(res, 1000 * i));
			}
			try {
				return await this.once(r, what, t);
			} catch (e) {
				lastErr = e;
			}
		}
		throw lastErr;
	}

	async status(): Promise<DeviceStatus> {
		// The reader's Wi-Fi and the first mDNS lookup can take several seconds to
		// wake, so the first probe often times out; back off with longer waits.
		const r = await this.req({ url: `${this.base}/api/status`, method: "GET" }, "Reaching the reader", 0, [6000, 8000, 12000]);
		if (r.status !== 200) throw new DeviceError(`Reader answered ${r.status} on /api/status`);
		try {
			return JSON.parse(r.text) as DeviceStatus;
		} catch {
			throw new DeviceError("Reader's /api/status did not return JSON — is this a CrossPoint device?");
		}
	}

	/** Lists a directory. Returns null if it does not exist. */
	async list(path: string): Promise<RemoteEntry[] | null> {
		const url = `${this.base}/api/files?path=${encodeURIComponent(joinPath(path))}`;
		const r = await this.req({ url, method: "GET" }, `Listing ${path}`);
		if (r.status === 404) return null;
		if (r.status !== 200) {
			// Older/newer firmwares may report a missing dir differently.
			if (/not\s*found|does not exist|no such/i.test(r.text)) return null;
			throw new DeviceError(`Listing ${path}: HTTP ${r.status} ${r.text.slice(0, 120)}`);
		}
		try {
			const arr = JSON.parse(r.text);
			return Array.isArray(arr) ? (arr as RemoteEntry[]) : null;
		} catch {
			throw new DeviceError(`Listing ${path}: unexpected response`);
		}
	}

	/** mkdir -p via WebDAV MKCOL; existing folders (405/409 on some servers) are fine. */
	async ensureDir(path: string): Promise<void> {
		const segs = joinPath(path).split("/").filter(Boolean);
		let cur = "";
		for (const s of segs) {
			cur += "/" + s;
			const r = await this.req({ url: `${this.base}${encodePath(cur)}/`, method: "MKCOL" }, `Creating ${cur}`);
			if (r.status >= 200 && r.status < 300) continue;
			if (r.status === 405 || r.status === 409 || r.status === 301) {
				// 405 = already exists. Verify it's a directory rather than trusting the code.
				const parent = cur.substring(0, cur.lastIndexOf("/")) || "/";
				const entries = await this.list(parent);
				if (entries?.some((e) => e.name === s && e.isDirectory)) continue;
			}
			throw new DeviceError(`Creating folder ${cur}: HTTP ${r.status}`);
		}
	}

	/** Upload via WebDAV PUT (server writes .davtmp then renames, so it's atomic). */
	async put(path: string, data: Uint8Array): Promise<void> {
		const body = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
		// Generous timeout: ESP32 Wi-Fi uploads run roughly 100–400 KB/s.
		const timeout = Math.max(30000, (data.byteLength / 50_000) * 1000);
		const r = await this.req(
			{ url: `${this.base}${encodePath(path)}`, method: "PUT", body, contentType: "application/epub+zip" },
			`Uploading ${path}`,
			timeout,
		);
		if (r.status < 200 || r.status >= 300) throw new DeviceError(`Uploading ${path}: HTTP ${r.status} ${r.text.slice(0, 120)}`);
	}

	async remove(path: string): Promise<void> {
		const r = await this.req({ url: `${this.base}${encodePath(path)}`, method: "DELETE" }, `Deleting ${path}`);
		if (r.status === 404) return;
		if (r.status < 200 || r.status >= 300) throw new DeviceError(`Deleting ${path}: HTTP ${r.status}`);
	}
}
