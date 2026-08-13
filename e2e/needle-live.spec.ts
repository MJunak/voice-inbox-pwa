import { test, expect } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { seedEntries } from "./helpers";

// ECHTER End-to-End-Test der Needle-WASM-Engine im Browser (Worker + Inferenz).
// Läuft nur mit RUN_NEEDLE_LIVE=1 und wenn die Gewichte lokal vorliegen; die
// HF-URLs werden per Route aus lokalen Dateien bedient (schnell/offline).
// Aufruf: RUN_NEEDLE_LIVE=1 WEIGHTS_DIR=<pfad> npx playwright test needle-live.spec.ts

const WEIGHTS_DIR = process.env.WEIGHTS_DIR ?? "";
const weightsPath = `${WEIGHTS_DIR}/needle.safetensors`;
const vocabPath = `${WEIGHTS_DIR}/vocab.txt`;
const enabled = process.env.RUN_NEEDLE_LIVE === "1" && WEIGHTS_DIR && existsSync(weightsPath) && existsSync(vocabPath);

test.skip(() => !enabled, "RUN_NEEDLE_LIVE=1 und WEIGHTS_DIR mit needle.safetensors/vocab.txt nötig");

test("echte Needle-Engine wechselt die Ansicht per Befehl", async ({ page }) => {
  test.setTimeout(60_000);

  // HF-Downloads aus lokalen Dateien bedienen (kein echter Netzzugriff nötig).
  await page.route(/needle\.safetensors/, (route) =>
    route.fulfill({ status: 200, headers: { "content-type": "application/octet-stream", "access-control-allow-origin": "*" }, body: readFileSync(weightsPath) }),
  );
  await page.route(/vocab\.txt/, (route) =>
    route.fulfill({ status: 200, headers: { "content-type": "text/plain", "access-control-allow-origin": "*" }, body: readFileSync(vocabPath) }),
  );

  await seedEntries(page, [
    { id: "a", kind: "Aufgabe", text: "Rechnung schreiben", created: "Gerade eben" },
    { id: "b", kind: "Termin", text: "Termin beim Zahnarzt", created: "Vor 5 Min." },
    { id: "c", kind: "Notiz", text: "Buchtipp von Anna", created: "Gestern" },
  ]);
  await page.goto("/");

  // Modell wird geladen -> Chip "Needle bereit".
  await expect(page.locator(".cmdModel.ready")).toBeVisible({ timeout: 45_000 });

  // Echter Befehl -> echte Inferenz -> Ansicht wechselt auf Liste.
  await page.getByRole("textbox", { name: /Befehl an die App/i }).fill("zeig mir die Liste");
  await page.getByRole("button", { name: "Ausführen" }).click();
  await expect(page.locator(".row")).toHaveCount(3, { timeout: 15_000 });

  // Und ein echter Lösch-Befehl per Texttreffer.
  await page.getByRole("textbox", { name: /Befehl an die App/i }).fill("lösche den Zahnarzt Termin");
  await page.getByRole("button", { name: "Ausführen" }).click();
  await expect(page.locator(".row")).toHaveCount(2, { timeout: 15_000 });
});
