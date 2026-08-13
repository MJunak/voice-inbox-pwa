import { test, expect } from "@playwright/test";
import { installSpeechMock, installNeedleMock, seedEntries } from "./helpers";

// Testet die Needle-Command-Verdrahtung mit einer gemockten Engine:
// Eingabe -> (gemockte) Needle-Tool-Call-JSON -> Executor -> App-Aktion.
// Die echte WASM-Engine wird hier bewusst NICHT geladen.

const seed = [
  { id: "a", kind: "Aufgabe", text: "Rechnung schreiben", created: "Gerade eben" },
  { id: "b", kind: "Termin", text: "Termin beim Zahnarzt", created: "Vor 5 Min." },
  { id: "c", kind: "Notiz", text: "Buchtipp von Anna", created: "Gestern" },
];

test.beforeEach(async ({ page }) => {
  await installSpeechMock(page);
  await installNeedleMock(page, [
    { match: "liste", response: '[{"name":"switch_view","arguments":{"view":"list"}}]' },
    { match: "karten", response: '[{"name":"switch_view","arguments":{"view":"cards"}}]' },
    { match: "zahnarzt löschen", response: '[{"name":"delete_note","arguments":{"match":"Zahnarzt"}}]' },
    { match: "nur termine", response: '[{"name":"filter_kind","arguments":{"kind":"Termin"}}]' },
    { match: "such", response: '[{"name":"search","arguments":{"query":"Anna"}}]' },
    { match: "aufgabe machen", response: '[{"name":"set_kind","arguments":{"match":"Buchtipp","kind":"Aufgabe"}}]' },
    { match: "notiz anlegen", response: '[{"name":"add_note","arguments":{"text":"Frisch angelegt per Befehl"}}]' },
    // Fuzzy-Ausgaben, wie sie das echte 26M-Modell liefert (nicht exakt der Enum-Wert):
    { match: "fuzzy liste", response: '[{"name":"switch_view","arguments":{"view":"Liste"}}]' },
    { match: "fuzzy english", response: '[{"name":"switch_view","arguments":{"view":"list view"}}]' },
    { match: "fuzzy task", response: '[{"name":"filter_kind","arguments":{"kind":"tasks"}}]' },
  ]);
});

async function command(page: import("@playwright/test").Page, text: string) {
  const input = page.getByRole("textbox", { name: /Befehl an die App/i });
  await input.fill(text);
  await page.getByRole("button", { name: "Ausführen" }).click();
}

test("Befehl wechselt in die Listenansicht", async ({ page }) => {
  await seedEntries(page, seed);
  await page.goto("/");
  await expect(page.locator(".card")).toHaveCount(3);
  await command(page, "zeig mir die liste");
  await expect(page.locator(".row")).toHaveCount(3);
  await expect(page.locator(".card")).toHaveCount(0);
});

test("Befehl löscht einen Eintrag per Texttreffer", async ({ page }) => {
  await seedEntries(page, seed);
  await page.goto("/");
  await expect(page.locator(".card")).toHaveCount(3);
  await command(page, "zahnarzt löschen");
  await expect(page.locator(".card")).toHaveCount(2);
  await expect(page.getByText("Termin beim Zahnarzt")).toHaveCount(0);
});

test("Befehl filtert nach Kategorie", async ({ page }) => {
  await seedEntries(page, seed);
  await page.goto("/");
  await command(page, "zeig nur termine");
  await expect(page.locator(".card")).toHaveCount(1);
  await expect(page.locator(".card").first()).toContainText("Zahnarzt");
});

test("Befehl durchsucht die Inbox", async ({ page }) => {
  await seedEntries(page, seed);
  await page.goto("/");
  await command(page, "such nach etwas");
  await expect(page.getByRole("textbox", { name: /Inbox durchsuchen/i })).toHaveValue("Anna");
  await expect(page.locator(".card")).toHaveCount(1);
  await expect(page.locator(".card").first()).toContainText("Anna");
});

test("Befehl ändert die Kategorie eines Eintrags", async ({ page }) => {
  await seedEntries(page, seed);
  await page.goto("/");
  await command(page, "mach das zur aufgabe machen");
  const anna = page.locator(".card", { hasText: "Buchtipp von Anna" });
  await expect(anna.locator(".tag")).toHaveText("Aufgabe");
});

test("Befehl legt einen neuen Eintrag an", async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto("/");
  await command(page, "bitte notiz anlegen");
  await expect(page.locator(".card")).toHaveCount(1);
  await expect(page.locator(".card").first()).toContainText("Frisch angelegt per Befehl");
});

test("verarbeitet unsaubere Enum-Ausgaben des Modells (fuzzy)", async ({ page }) => {
  await seedEntries(page, seed);
  await page.goto("/");
  // "Liste" statt "list"
  await command(page, "fuzzy liste");
  await expect(page.locator(".row")).toHaveCount(3);
  // "list view" statt "list"
  await command(page, "fuzzy karten dummy"); // erst zurück auf Karten
  await command(page, "fuzzy english");
  await expect(page.locator(".row")).toHaveCount(3);
  // "tasks" statt "Aufgabe"
  await command(page, "fuzzy task");
  await expect(page.locator(".row")).toHaveCount(1);
  await expect(page.locator(".row").first()).toContainText("Rechnung");
});

test("unbekannter Befehl meldet, dass nichts erkannt wurde", async ({ page }) => {
  await seedEntries(page, seed);
  await page.goto("/");
  await command(page, "völlig unverständliches kauderwelsch");
  await expect(page.getByText(/Kein passender Befehl erkannt/i)).toBeVisible();
  await expect(page.locator(".card")).toHaveCount(3);
});
