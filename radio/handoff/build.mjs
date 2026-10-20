#!/usr/bin/env node
// Build the phone page into ONE self-contained file, radio/handoff/index.html: every script,
// style and the ggwave WebAssembly inline, so it works saved on a phone with no internet.
//
//   node radio/handoff/build.mjs
import { build } from "esbuild";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const shims = here("./src/shims.mjs");
const out = await build({
  entryPoints: [here("./src/app.mjs")],
  bundle: true, minify: true, write: false, format: "iife", platform: "browser", target: "es2020",
  alias: { "node:crypto": shims },
  inject: [shims],
  external: ["fs", "path"], // ggwave's Node-only branch; never reached in a browser
  legalComments: "eof",
  logLevel: "warning",
});
const js = out.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");

// Licences of everything bundled, kept with the page. Two packages ship no licence file, so their
// MIT notices are written out from the copyright lines in their sources and package.json.
const mit = (who) => `Copyright (c) ${who}

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
const nm = (p) => fileURLToPath(new URL(`../../node_modules/${p}`, import.meta.url));
const lic = (p) => readFileSync(nm(p), "utf8").trim();
const notices = [
  ["ggwave 0.4.0 (MIT)", mit("Georgi Gerganov")],
  ["qrcode-generator 2.0.4 (MIT)", mit("2009 Kazuhiko Arase")],
  ["jsqr 1.4.0 (Apache-2.0)", lic("jsqr/LICENSE")],
  ["buffer 6.0.3 (MIT)", lic("buffer/LICENSE")],
  ["base64-js (MIT)", lic("base64-js/LICENSE")],
  ["ieee754 (BSD-3-Clause)", lic("ieee754/LICENSE")],
  ["@bsv/sdk (Open BSV License)", lic("@bsv/sdk/LICENSE.txt")],
  ["@bsv/sdk third-party notices (SJCL is used under its BSD-2-Clause option)", lic("@bsv/sdk/THIRD_PARTY_NOTICES.md")],
  ...readdirSync(nm("@bsv/sdk/LICENSES")).sort().map((f) => [`@bsv/sdk bundled component: ${f}`, lic(`@bsv/sdk/LICENSES/${f}`)]),
].map(([name, text]) => `==== ${name} ====\n\n${text}`).join("\n\n");
writeFileSync(here("./THIRD-PARTY-NOTICES.txt"), notices + "\n");
const page = readFileSync(here("./src/page.html"), "utf8")
  .replace("<script>/*APP*/</script>", () => `<script>${js}</script>`)
  .replace("</html>", () => `</html>\n<!-- Third-party software in this page and its licences:\n\n${notices.replace(/--/g, "- -")}\n-->\n`);
writeFileSync(here("./index.html"), page);
console.log(`radio/handoff/index.html: ${(page.length / 1024).toFixed(0)} KB, self-contained`);
