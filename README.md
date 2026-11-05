# CrossPoint Push

Obsidian plugin that converts a vault folder to EPUB and sends it over Wi-Fi to an Xteink reader running CrossPoint firmware.

## Install

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/nevetssf/crosspoint-push/releases/latest).
2. Put them in `<vault>/.obsidian/plugins/crosspoint-push/`.
3. In Obsidian: Settings → Community plugins → enable **CrossPoint Push**.
4. In the plugin settings, set **Vault folder to push** and press **Test** next to the reader address.

## Use

On the reader, open **File Transfer → Join a Network**. Then in Obsidian, any of:

- Ribbon icon or command **Push configured folder to reader**: full sync of the configured folder.
- Right-click any folder or note → **Push to CrossPoint reader**: push just that.
- Command **Push current note to reader**.

The reader's web server only runs while it is on the File Transfer screen. If `crosspoint.local` doesn't resolve (common on phones), use the IP shown on the reader. In hotspot mode it is usually `192.168.4.1`.

## What it does

- **Bundling**: one EPUB per note, or one EPUB per folder with each note as a chapter (natural sort, so `2 …` comes before `10 …`). Subfolders are mirrored under the destination folder.
- **Existing books**: `.epub`, `.xtc`, `.xtch` files in the folder are sent unchanged.
- **Rendering**: uses Obsidian's own Markdown renderer, then cleans the result for e-ink:
  - wikilinks resolve; links between chapters of the same book stay clickable, other links become plain text
  - `![[Note]]`, `![[Note#Heading]]`, `![[Note#^block]]` are inlined (3 levels deep, cycle-safe)
  - callouts become a blockquote with a bold title
  - task checkboxes become `[ ]` / `[x]`
  - footnotes keep working links
  - math and Mermaid show their source as code (they render to SVG, which the reader can't show)
  - frontmatter is dropped; a `title:` field is used as the chapter/book title
- **Images**: PNG/JPEG are scaled to 800 px on the long edge and re-encoded. JPEGs are always re-encoded, because CrossPoint can't decode progressive JPEGs. GIF/WebP/SVG and remote images become a text placeholder.
- **Incremental**: each book is keyed on a hash of its notes, embedded notes and images (by mtime), plus render settings. Unchanged books aren't rebuilt or re-sent. A book missing or a different size on the reader is re-sent. Built EPUBs are cached in the plugin folder.
- **Deletes** (off by default): when enabled, a full sync removes books this plugin uploaded earlier whose notes are gone. Files it never uploaded are never touched.

Uploads use WebDAV `PUT`, which the reader writes to a temp file and renames, so an interrupted upload never leaves a half-written book.

## Limits

- Dataview and other plugin blocks are captured as they look after one render pass; async queries may come out empty.
- Links to notes in *other* books are plain text (EPUB can't link across books).
- The reader's web server has no authentication; push only on networks you trust.

## Development

```
npm install
npm run build   # typecheck + bundle to main.js
npm test        # runs against a mock CrossPoint server (needs python3)
```

The tests cover EPUB packaging, the device client, folder-to-reader path mapping, and change detection/deletes. Markdown rendering needs Obsidian itself and isn't covered by them.

## Releasing

Bump `version` in `manifest.json` and `package.json`, add it to `versions.json`, commit and push, then run **Actions → Release → Run workflow** (or push a matching tag). The workflow builds, runs the tests, and publishes `main.js` and `manifest.json` as that version.
