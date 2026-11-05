// Minimal EPUB 3 writer (with an EPUB 2 NCX for older parsers).
// Pure: depends only on JSZip, so it can be unit-tested outside Obsidian.
import JSZip from "jszip";

export interface Chapter {
	id: string;       // xml id, e.g. "ch001"
	title: string;
	xhtmlBody: string; // serialized XHTML fragment (body content only)
}

export interface Resource {
	href: string;      // relative to OEBPS, e.g. "images/img001.png"
	mediaType: string; // e.g. "image/png"
	data: Uint8Array;
}

export interface BookSpec {
	uid: string;
	title: string;
	author?: string;
	language?: string;
	chapters: Chapter[];
	resources: Resource[];
	css?: string;
}

// Fixed timestamp so identical input produces byte-identical output.
const FIXED_DATE = new Date(Date.UTC(2020, 0, 1));
const MODIFIED = "2020-01-01T00:00:00Z";

export const DEFAULT_CSS = `
body { margin: 0; line-height: 1.4; }
h1, h2, h3, h4, h5, h6 { line-height: 1.2; margin: 1em 0 0.4em; page-break-after: avoid; }
p { margin: 0 0 0.6em; }
blockquote { margin: 0.6em 0 0.6em 1em; padding-left: 0.6em; border-left: 2px solid #000; }
.callout-title { font-weight: bold; }
pre, code { font-family: monospace; font-size: 0.9em; }
pre { white-space: pre-wrap; }
table { border-collapse: collapse; }
td, th { border: 1px solid #000; padding: 0.2em 0.4em; }
img { max-width: 100%; }
hr { border: 0; border-top: 1px solid #000; }
`.trim();

export function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function chapterDoc(ch: Chapter, lang: string): string {
	return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${esc(lang)}" lang="${esc(lang)}">
<head>
<meta charset="utf-8"/>
<title>${esc(ch.title)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${ch.xhtmlBody}
</body>
</html>
`;
}

export async function buildEpub(spec: BookSpec): Promise<Uint8Array> {
	const lang = spec.language ?? "en";
	const author = spec.author ?? "Obsidian";
	const zip = new JSZip();
	const opts = { date: FIXED_DATE, createFolders: false };

	// mimetype must be first and stored uncompressed.
	zip.file("mimetype", "application/epub+zip", { ...opts, compression: "STORE" });

	zip.file(
		"META-INF/container.xml",
		`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`,
		opts,
	);

	zip.file("OEBPS/style.css", spec.css ?? DEFAULT_CSS, opts);

	for (const ch of spec.chapters) {
		zip.file(`OEBPS/${ch.id}.xhtml`, chapterDoc(ch, lang), opts);
	}
	for (const r of spec.resources) {
		zip.file(`OEBPS/${r.href}`, r.data, { ...opts, binary: true });
	}

	const manifestItems = [
		`<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
		`<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
		`<item id="css" href="style.css" media-type="text/css"/>`,
		...spec.chapters.map(
			(c) => `<item id="${c.id}" href="${c.id}.xhtml" media-type="application/xhtml+xml"/>`,
		),
		...spec.resources.map(
			(r, i) => `<item id="res${i + 1}" href="${esc(r.href)}" media-type="${r.mediaType}"/>`,
		),
	];
	const spine = spec.chapters.map((c) => `<itemref idref="${c.id}"/>`);

	zip.file(
		"OEBPS/content.opf",
		`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${esc(lang)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${esc(spec.uid)}</dc:identifier>
    <dc:title>${esc(spec.title)}</dc:title>
    <dc:creator>${esc(author)}</dc:creator>
    <dc:language>${esc(lang)}</dc:language>
    <meta property="dcterms:modified">${MODIFIED}</meta>
  </metadata>
  <manifest>
    ${manifestItems.join("\n    ")}
  </manifest>
  <spine toc="ncx">
    ${spine.join("\n    ")}
  </spine>
</package>
`,
		opts,
	);

	zip.file(
		"OEBPS/nav.xhtml",
		`<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${esc(lang)}" lang="${esc(lang)}">
<head><meta charset="utf-8"/><title>${esc(spec.title)}</title></head>
<body>
<nav epub:type="toc" id="toc">
<h1>Contents</h1>
<ol>
${spec.chapters.map((c) => `<li><a href="${c.id}.xhtml">${esc(c.title)}</a></li>`).join("\n")}
</ol>
</nav>
</body>
</html>
`,
		opts,
	);

	zip.file(
		"OEBPS/toc.ncx",
		`<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${esc(spec.uid)}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${esc(spec.title)}</text></docTitle>
  <navMap>
${spec.chapters
	.map(
		(c, i) => `    <navPoint id="np${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${esc(c.title)}</text></navLabel>
      <content src="${c.id}.xhtml"/>
    </navPoint>`,
	)
	.join("\n")}
  </navMap>
</ncx>
`,
		opts,
	);

	return zip.generateAsync({
		type: "uint8array",
		compression: "DEFLATE",
		compressionOptions: { level: 9 },
		mimeType: "application/epub+zip",
	});
}
