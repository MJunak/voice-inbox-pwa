import { test, expect } from "@playwright/test";
import { installSpeechMock, installNeedleMock, seedEntries, emitSpeech } from "./helpers";

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
    { match: "wo war", response: '[{"name":"search","arguments":{"query":"Anna"}}]' },
    { match: "aufgabe machen", response: '[{"name":"set_kind","arguments":{"match":"Buchtipp","kind":"Aufgabe"}}]' },
    { match: "notiz anlegen", response: '[{"name":"add_note","arguments":{"text":"Frisch angelegt per Befehl"}}]' },
    // Fuzzy-Ausgaben, wie sie das echte 26M-Modell liefert (nicht exakt der Enum-Wert):
    { match: "fuzzy liste", response: '[{"name":"switch_view","arguments":{"view":"Liste"}}]' },
    { match: "fuzzy english", response: '[{"name":"switch_view","arguments":{"view":"list view"}}]' },
    { match: "fuzzy task", response: '[{"name":"filter_kind","arguments":{"kind":"tasks"}}]' },
    // Positional: das Modell reicht "letzte Notiz" als match-Text durch.
    { match: "letzte notiz", response: '[{"name":"delete_note","arguments":{"match":"letzte Notiz"}}]' },
    // Doppelter Key mit Parameter-Echo (real beobachtete Modell-Ausgabe).
    { match: "dupkey", response: '[{"name":"filter_kind","arguments":{"kind":"Termin","kind":"kind"}}]' },
    // Needle-2-Envelope (echtes Antwortformat inkl. Metadaten).
    { match: "envelope", response: '{"type":"call","success":true,"error":null,"function_calls":[{"name":"filter_kind","arguments":{"kind":"Idee"}}],"reasoning":"\'ideen\' -> kind Idee","confidence":0.91}' },
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

test("Befehl durchsucht die Inbox (Fast-Path)", async ({ page }) => {
  await seedEntries(page, seed);
  await page.goto("/");
  await command(page, "such nach Anna");
  await expect(page.getByRole("textbox", { name: /Inbox durchsuchen/i })).toHaveValue("Anna");
  await expect(page.locator(".card")).toHaveCount(1);
  await expect(page.locator(".card").first()).toContainText("Anna");
});

test("Befehl durchsucht die Inbox (Modellpfad)", async ({ page }) => {
  await seedEntries(page, seed);
  await page.goto("/");
  // Formulierung, die der Fast-Path nicht abdeckt -> geht durch die (Mock-)Engine.
  await command(page, "wo war das mit Anna");
  await expect(page.getByRole("textbox", { name: /Inbox durchsuchen/i })).toHaveValue("Anna");
  await expect(page.locator(".card")).toHaveCount(1);
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

test("Befehl löscht die letzte Notiz (positionale Referenz)", async ({ page }) => {
  await seedEntries(page, seed);
  await page.goto("/");
  await command(page, "Lösch die letzte notiz");
  await expect(page.locator(".card")).toHaveCount(2);
  await expect(page.locator(".card", { hasText: "Buchtipp von Anna" })).toHaveCount(0);
  await expect(page.locator(".notice")).toContainText("Neuester Eintrag gelöscht");
});

test("übersteht doppelte Argument-Keys (Parameter-Echo)", async ({ page }) => {
  await seedEntries(page, seed);
  await page.goto("/");
  await command(page, "dupkey filter");
  // Trotz {"kind":"Termin","kind":"kind"} muss der erste Wert gewinnen.
  await expect(page.locator(".card")).toHaveCount(1);
  await expect(page.locator(".card").first()).toContainText("Zahnarzt");
});

test("Debug-Panel zeigt Fast-Path-Ausführung", async ({ page }) => {
  await seedEntries(page, seed);
  await page.goto("/");
  await command(page, "zeig mir die liste"); // Fast-Path, ohne Modell
  await page.getByText("Debug: Inferenz").click();
  const panel = page.locator(".debugPanel");
  await expect(panel.locator("code")).toContainText('"name":"switch_view"');
  await expect(panel.getByText("Fast-Path", { exact: false })).toBeVisible();
  await expect(panel.getByText("sofort")).toBeVisible();
});

test("Debug-Panel zeigt Modellpfad mit Envelope-Infos", async ({ page }) => {
  await seedEntries(page, seed);
  await page.goto("/");
  // Needle-2-Envelope inkl. reasoning/confidence über den Mock zurückgeben.
  await command(page, "wo war das mit Anna");
  await page.getByText("Debug: Inferenz").click();
  const panel = page.locator(".debugPanel");
  await expect(panel.getByText("Needle 2 (WASM)")).toBeVisible();
  await expect(panel.locator("code")).toContainText('"name":"search"');
});

test("verarbeitet das Needle-2-Envelope-Format", async ({ page }) => {
  await seedEntries(page, [...seed, { id: "d", kind: "Idee", text: "App-Idee festhalten", created: "Gestern" }]);
  await page.goto("/");
  await command(page, "envelope bitte");
  await expect(page.locator(".card")).toHaveCount(1);
  await expect(page.locator(".card").first()).toContainText("App-Idee");
  // Metadaten aus dem Envelope landen im Debug-Panel.
  await page.getByText("Debug: Inferenz").click();
  await expect(page.locator(".debugPanel").getByText("91.0 %")).toBeVisible();
  await expect(page.locator(".debugPanel").getByText("'ideen' -> kind Idee", { exact: true })).toBeVisible();
});

test("Sprachbefehl über die Command-Bar wird automatisch ausgeführt", async ({ page }) => {
  await seedEntries(page, seed);
  await page.goto("/");
  await page.getByRole("button", { name: "Befehl einsprechen" }).click();
  // Interim-Ergebnis erscheint live im Eingabefeld, führt aber nicht aus.
  await emitSpeech(page, "zeig mir die", false);
  await expect(page.getByRole("textbox", { name: /Befehl an die App/i })).toHaveValue("zeig mir die");
  await expect(page.locator(".card")).toHaveCount(3);
  // Finales Ergebnis -> automatische Ausführung (Fast-Path: Listenansicht).
  await emitSpeech(page, "zeig mir die liste", true);
  await expect(page.locator(".row")).toHaveCount(3);
  await expect(page.locator(".card")).toHaveCount(0);
  // Erfolgreich ausgeführt -> Eingabefeld geleert, Aufnahme beendet.
  await expect(page.getByRole("textbox", { name: /Befehl an die App/i })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Befehl einsprechen" })).toBeVisible();
});

test("versteht spanische Befehle (Fast-Path)", async ({ page }) => {
  await seedEntries(page, seed);
  await page.goto("/");
  await command(page, "muestra la lista");
  await expect(page.locator(".row")).toHaveCount(3);
  await command(page, "borra la última nota");
  await expect(page.locator(".row")).toHaveCount(2);
  await expect(page.locator(".row", { hasText: "Buchtipp von Anna" })).toHaveCount(0);
  await command(page, "solo citas");
  await expect(page.locator(".row")).toHaveCount(1);
  await expect(page.locator(".row").first()).toContainText("Zahnarzt");
  await command(page, "muestra todo");
  await expect(page.locator(".row")).toHaveCount(2);
  await command(page, "busca por Rechnung");
  await expect(page.locator(".row")).toHaveCount(1);
  await expect(page.locator(".row").first()).toContainText("Rechnung");
});

test("Sprach-Dropdown stellt die Erkennungssprache um und bleibt gespeichert", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("combobox", { name: /Sprache der Spracherkennung/i }).selectOption("es-ES");
  await page.getByRole("button", { name: "Befehl einsprechen" }).click();
  const lang = await page.evaluate(() => (window as unknown as { __activeRecognition?: { lang: string } }).__activeRecognition?.lang);
  expect(lang).toBe("es-ES");
  // Persistenz über Reload
  await page.reload();
  await expect(page.getByRole("combobox", { name: /Sprache der Spracherkennung/i })).toHaveValue("es-ES");
});

test("unbekannter Befehl meldet, dass nichts erkannt wurde", async ({ page }) => {
  await seedEntries(page, seed);
  await page.goto("/");
  await command(page, "völlig unverständliches kauderwelsch");
  await expect(page.locator(".notice")).toContainText(/Kein passender Befehl erkannt/i);
  await expect(page.locator(".card")).toHaveCount(3);
});
