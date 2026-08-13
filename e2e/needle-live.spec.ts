import { test, expect } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { seedEntries } from "./helpers";

// ECHTER End-to-End-Test der Needle-2-WASM-Engine im Browser (Worker + Inferenz).
// Läuft nur mit RUN_NEEDLE_LIVE=1 und wenn die Assets lokal vorliegen; die
// HF-URLs werden per Route aus lokalen Dateien bedient (schnell/offline).
// Benötigte Dateien in WEIGHTS_DIR: needle.wasm (Engine) + needle2.cact (Modell),
// z. B. via: curl -L https://huggingface.co/Cactus-Compute/needle2/resolve/main/wasm/needle.wasm
// Aufruf: RUN_NEEDLE_LIVE=1 WEIGHTS_DIR=<pfad> npx playwright test needle-live.spec.ts

const WEIGHTS_DIR = process.env.WEIGHTS_DIR ?? "";
const wasmPath = `${WEIGHTS_DIR}/needle.wasm`;
const cactPath = `${WEIGHTS_DIR}/needle2.cact`;
const enabled = process.env.RUN_NEEDLE_LIVE === "1" && WEIGHTS_DIR && existsSync(wasmPath) && existsSync(cactPath);

test.skip(() => !enabled, "RUN_NEEDLE_LIVE=1 und WEIGHTS_DIR mit needle.wasm/needle2.cact nötig");

test("echte Needle-2-Engine führt Befehle aus (Fast-Path + Modell)", async ({ page }) => {
  test.setTimeout(120_000);

  // Assets über einen lokalen HTTP-Server bedienen. WICHTIG: kein
  // page.route/fulfill – Playwright schneidet große Binaries bei Fetches aus
  // Web Workern ab (beobachtet: 13,7 MB -> 17 KB), was das Modell korrumpiert.
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    const file = req.url?.includes("cact") ? cactPath : wasmPath;
    res.writeHead(200, { "content-type": "application/octet-stream", "access-control-allow-origin": "*" });
    res.end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(8917, resolve));
  await page.addInitScript(() => {
    (window as unknown as { __NEEDLE2_WASM_URL?: string; __NEEDLE2_CACT_URL?: string }).__NEEDLE2_WASM_URL = "http://localhost:8917/needle.wasm";
    (window as unknown as { __NEEDLE2_WASM_URL?: string; __NEEDLE2_CACT_URL?: string }).__NEEDLE2_CACT_URL = "http://localhost:8917/needle2.cact";
  });

  await seedEntries(page, [
    { id: "a", kind: "Aufgabe", text: "Rechnung schreiben", created: "Gerade eben" },
    { id: "b", kind: "Termin", text: "Termin beim Zahnarzt", created: "Vor 5 Min." },
    { id: "c", kind: "Notiz", text: "Buchtipp von Anna", created: "Gestern" },
  ]);
  await page.goto("/");

  // Preload: Modell wird geladen und Tools gebunden -> Chip "Needle bereit".
  await expect(page.locator(".cmdModel.ready")).toBeVisible({ timeout: 60_000 });

  const input = page.getByRole("textbox", { name: /Befehl an die App/i });
  const submit = page.getByRole("button", { name: "Ausführen" });

  // 1) Fast-Path (ohne Modell, sofort): Listenansicht.
  await input.fill("zeig mir die Liste");
  await submit.click();
  await expect(page.locator(".row")).toHaveCount(3);

  // 2) Echte Inferenz: Notiz anlegen (im Browser verifizierter Modell-Fall).
  //    Modellpfad zeigt erst eine Vorschau, die bestätigt werden muss.
  await input.fill("leg eine Notiz an: Milch kaufen");
  await submit.click();
  const preview = page.getByRole("dialog", { name: /Vorschau der Aktion/i });
  await expect(preview).toContainText("Neuen Eintrag anlegen", { timeout: 30_000 });
  await page.getByRole("button", { name: "Bestätigen" }).click();
  await expect(page.locator(".row")).toHaveCount(4);
  await expect(page.locator(".row", { hasText: "Milch kaufen" })).toHaveCount(1);

  // 3) Fast-Path positional: neueste Notiz (= gerade angelegte) löschen.
  await input.fill("Lösch die letzte Notiz");
  await submit.click();
  await expect(page.locator(".row")).toHaveCount(3);
  await expect(page.locator(".row", { hasText: "Milch kaufen" })).toHaveCount(0);

  server.close();
});
