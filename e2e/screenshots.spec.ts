import { test, expect, type Page } from "@playwright/test";
import { installSpeechMock, installNeedleMock, seedEntries } from "./helpers";

// Diese Datei erzeugt keine Assertions, sondern gut benannte Screenshots unter
// e2e/screens/. Damit lässt sich das visuelle Ergebnis vor einem Commit prüfen.
// Aufruf gezielt:  pnpm test:e2e:shots   (siehe package.json)

const sampleEntries = [
  { id: "1", kind: "Aufgabe", text: "Rechnung an Kunde Meyer bis Freitag rausschicken", created: "Gerade eben" },
  { id: "2", kind: "Termin", text: "Termin Montag 09:00 Zahnarzt", created: "Vor 5 Min." },
  { id: "3", kind: "Idee", text: "Idee: Wochenrückblick automatisch als Markdown exportieren", created: "Vor 1 Std." },
  { id: "4", kind: "Notiz", text: "Passwort-Manager Lizenz läuft im März aus", created: "Gestern" },
];

// Erst aufnehmen, wenn die Seite zur Ruhe gekommen ist (Dev-Server kann beim
// ersten Aufruf noch nachladen); Animationen für stabile Bilder anhalten.
async function shot(page: Page, path: string) {
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
}

test.beforeEach(async ({ page }) => {
  await installSpeechMock(page);
  await installNeedleMock(page, []);
});

test("screenshot: leerer Zustand", async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto("/");
  await page.getByRole("heading", { name: "Inbox", exact: true }).waitFor();
  await shot(page, "e2e/screens/01-empty.png");
});

test("screenshot: mit Einträgen", async ({ page }) => {
  await seedEntries(page, sampleEntries);
  await page.goto("/");
  await page.locator(".card").first().waitFor();
  await shot(page, "e2e/screens/02-entries.png");
});

test("screenshot: Listenansicht", async ({ page }) => {
  await seedEntries(page, sampleEntries);
  await page.goto("/");
  await page.getByRole("button", { name: /Listenansicht/i }).click();
  await page.locator(".row").first().waitFor();
  await shot(page, "e2e/screens/04-list.png");
});

test("screenshot: Debug-Panel nach Befehl", async ({ page }) => {
  await installNeedleMock(page, [
    { match: "liste", response: '[{"name":"switch_view","arguments":{"view":"list"}}]' },
  ]);
  await seedEntries(page, sampleEntries);
  await page.goto("/");
  await page.getByRole("textbox", { name: /Befehl an die App/i }).fill("zeig mir die Liste");
  await page.getByRole("button", { name: "Ausführen" }).click();
  await page.locator(".row").first().waitFor();
  await page.getByText("Debug: Inferenz").click();
  await shot(page, "e2e/screens/05-debug.png");
});

test("screenshot: Aktions-Vorschau (Modellpfad)", async ({ page }) => {
  await installNeedleMock(page, [
    { match: "zahnarzt", response: '{"type":"call","function_calls":[{"name":"delete_note","arguments":{"match":"Zahnarzt"}}],"confidence":0.87}' },
  ]);
  await seedEntries(page, sampleEntries);
  await page.goto("/");
  await page.getByRole("textbox", { name: /Befehl an die App/i }).fill("räum den zahnarzt eintrag weg");
  await page.getByRole("button", { name: "Ausführen" }).click();
  await page.getByRole("dialog", { name: /Vorschau der Aktion/i }).waitFor();
  await shot(page, "e2e/screens/06-preview.png");
});

test("screenshot: Composer mit Text", async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: /neuen Inbox-Eintrag/i });
  await composer.fill("Beispieltext im Composer, den man vor dem Ablegen noch bearbeiten kann.");
  await expect(composer).toHaveValue(/Beispieltext/);
  await shot(page, "e2e/screens/03-composer.png");
});
