import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const outputRoot = new URL("../dist-pages/", import.meta.url);

test("builds the static Voice Inbox entry point", async () => {
  const html = await readFile(new URL("index.html", outputRoot), "utf8");

  assert.match(html, /<html lang="de">/);
  assert.match(html, /<title>Voice Inbox – Sprich es aus<\/title>/);
  assert.match(html, /<div id="root"><\/div>/);
  assert.match(html, /<script[^>]+src="[^"]*\/assets\/[^"]+\.js"/);
  assert.match(html, /<link[^>]+href="[^"]*\/assets\/[^"]+\.css"/);
});

test("copies all installable PWA assets", async () => {
  await Promise.all([
    access(new URL("manifest.webmanifest", outputRoot)),
    access(new URL("sw.js", outputRoot)),
    access(new URL("favicon.svg", outputRoot)),
  ]);
});

test("emits the application bundle", async () => {
  const html = await readFile(new URL("index.html", outputRoot), "utf8");
  const scriptPath = html.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];

  assert.ok(scriptPath, "the generated HTML must reference a JavaScript bundle");
  const bundleName = scriptPath.split("/").at(-1);
  const bundleUrl = new URL(`assets/${bundleName}`, outputRoot);
  const bundle = await readFile(bundleUrl, "utf8");
  assert.match(bundle, /Voice Inbox/);
  assert.match(bundle, /voice-inbox-entries/);
});
