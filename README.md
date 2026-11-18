# ClaudeCAD

A 2D CAD program that runs inside a Claude artifact, with Claude's chat working as its terminal.

You draw and select in the CAD window; in the chat you ask things like "what is selected?",
"erase it", "set these to ByLayer" or "save", and Claude reads the selection and runs the
commands in the program. Drawings are kept in the artifact's cloud storage, grouped by project,
and only go to the PC when you export them.

Idea and project: João Raposo.

## What is in this folder

| File | What it is |
|---|---|
| `index.html` | The page: hosts the CAD program, the cloud file panel and the link with Claude |
| `cadcraft-web.js`, `cadcraft-web_bg.gz.wasm` | The CAD engine, CADCraft compiled to WebAssembly (gzip-compressed; the page inflates it) |
| `snippets/` | Small helper script the engine loads |
| `importers.js` | Converts DWG, PDF and DWFX to DXF in the browser before the program opens them |
| `gocad/` | [go-cad](https://github.com/unitedrhino/go-cad) (Apache-2.0) compiled to WebAssembly, used for DWG: `main.go` is the small bridge it was built from, `wasm_exec.js` is Go's loader (BSD) |
| `pdfjs/` | [pdf.js](https://github.com/mozilla/pdf.js) 4.10.38 (Apache-2.0), used for PDF |
| `viewer.html` | A simple read-only DXF viewer, used when the browser cannot start the engine |
| `Drawing1.dxf.txt` | Generic JR line drawing opened when there is nothing in the cloud |
| `LICENSE-MIT.txt`, `LICENSE-APACHE.txt`, `NOTICE.txt` | CADCraft's licences and notice |

## Opening DWG, PDF and DWFX

The CAD engine reads DXF only, so **Open from PC** (or dropping a file on the page) converts the
other formats to DXF first, in the browser; nothing is sent anywhere. The converted drawing opens
as `<name>.dxf`, and SAVE stores that DXF.

| Format | How it is read | What you get |
|---|---|---|
| DXF | Opened as is | The drawing |
| DWG (R9 to 2018) | go-cad writes a DXF of the whole drawing | Entities, layers, blocks, dimensions, texts |
| PDF | pdf.js reads each page's vector paths and text | Lines/polylines and texts in mm, one layer per page (`PDF-P1`, …), pages side by side, a sheet border on `PDF-SHEET` |
| DWFX | Read directly: its 2D sheets are XPS pages | Lines/polylines and texts in mm, one layer per sheet (`DWFX-S1`, …), sheet borders on `DWFX-SHEET` |

PDF and DWFX hold only what is printed, not CAD objects: curves become polylines, hatches and
fills become their outlines, images are skipped, and scanned PDFs have no vectors at all.
Classic binary DWF and 3D-only DWFX are not supported. Each converter is only downloaded the
first time a file of its kind is opened.

## How the link with Claude works

The page uses three artifact capabilities: `db` (a small database), `assets` (file storage)
and `downloads` (export to the PC).

- **Cloud files.** Each drawing is an asset; a `drawings` row holds its name, project, size and
  date. Empty projects live in `projects`.
- **Selection.** Every 1.5 s the page asks the engine what is selected (`drawing.inspect`, then
  `entities {selected: true}`) and, when it changes, writes a summary to `live/selection`:
  count, totals by type and layer, lengths, handles and geometry.
- **Commands.** Claude writes a row to `commands` (`{method, params, status: "pending"}`); the
  page runs it through the engine's control API (`window.cadcraft.request`) and writes the
  result back to the same row. Commands older than 10 minutes are discarded.

## Running it outside Claude

Serve the folder from any static web server (for example `python3 -m http.server 8765`) and
open `http://localhost:8765/`. The CAD program works on its own; the cloud panel, the
selection report and the chat commands need Claude's artifact capabilities and are off
anywhere else. Save and export then fall back to a normal browser download.

## Credits and licence

The CAD engine is [CADCraft](https://github.com/storytold/cadcraft), MIT OR Apache-2.0; its
licence files and notice must stay with any copy of the engine. The DWG converter, go-cad, and pdf.js
are Apache-2.0 (`LICENSE-APACHE.txt`); Go's loader `gocad/wasm_exec.js` is BSD (`gocad/GO-LICENSE.txt`).

To rebuild the DWG converter: copy `gocad/main.go` to `cmd/gocad-wasm/` in a go-cad checkout
(commit ddd91eea) and run `GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" ./cmd/gocad-wasm`,
then gzip the result to `gocad/gocad.gz.wasm` and copy that Go version's `lib/wasm/wasm_exec.js`. The page and the Claude
integration are by João Raposo.
