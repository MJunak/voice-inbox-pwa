import { test } from "@playwright/test";
import { installSpeechMock, seedEntries } from "./helpers";

// Diese Datei erzeugt keine Assertions, sondern gut benannte Screenshots unter
// e2e/screens/. Damit lässt sich das visuelle Ergebnis vor einem Commit prüfen.
// Aufruf gezielt:  pnpm test:e2e:shots   (siehe package.json)

const sampleEntries = [
  { id: "1", kind: "Aufgabe", text: "Rechnung an Kunde Meyer bis Freitag rausschicken", created: "Gerade eben" },
  { id: "2", kind: "Termin", text: "Termin Montag 09:00 Zahnarzt", created: "Vor 5 Min." },
  { id: "3", kind: "Idee", text: "Idee: Wochenrückblick automatisch als Markdown exportieren", created: "Vor 1 Std." },
  { id: "4", kind: "Notiz", text: "Passwort-Manager Lizenz läuft im März aus", created: "Gestern" },
];

test.beforeEach(async ({ page }) => {
  await installSpeechMock(page);
});

test("screenshot: leerer Zustand", async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto("/");
  await page.getByRole("heading", { name: "Inbox", exact: true }).waitFor();
  await page.screenshot({ path: "e2e/screens/01-empty.png", fullPage: true });
});

test("screenshot: mit Einträgen", async ({ page }) => {
  await seedEntries(page, sampleEntries);
  await page.goto("/");
  await page.locator(".card").first().waitFor();
  await page.screenshot({ path: "e2e/screens/02-entries.png", fullPage: true });
});

test("screenshot: Listenansicht", async ({ page }) => {
  await seedEntries(page, sampleEntries);
  await page.goto("/");
  await page.getByRole("button", { name: /Listenansicht/i }).click();
  await page.locator(".row").first().waitFor();
  await page.screenshot({ path: "e2e/screens/04-list.png", fullPage: true });
});

test("screenshot: Composer mit Text", async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto("/");
  await page
    .getByRole("textbox", { name: /neuen Inbox-Eintrag/i })
    .fill("Beispieltext im Composer, den man vor dem Ablegen noch bearbeiten kann.");
  await page.screenshot({ path: "e2e/screens/03-composer.png", fullPage: true });
});
