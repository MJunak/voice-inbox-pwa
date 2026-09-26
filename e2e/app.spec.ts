import { test, expect } from "@playwright/test";
import { installSpeechMock, installNeedleMock, emitSpeech } from "./helpers";

test.beforeEach(async ({ page }) => {
  await installSpeechMock(page);
  await installNeedleMock(page, []); // verhindert echten Modell-Download beim Preload
  await page.addInitScript(() => localStorage.clear());
});

test("lädt die App und zeigt den leeren Zustand", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Voice Inbox/);
  await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
  await expect(page.getByText("Noch keine Einträge.")).toBeVisible();
});

test("legt einen getippten Eintrag in der Inbox ab", async ({ page }) => {
  await page.goto("/");
  const textarea = page.getByRole("textbox", { name: /neuen Inbox-Eintrag/i });
  await textarea.fill("Ich muss die Rechnung bezahlen");
  await page.getByRole("button", { name: /In Inbox ablegen/i }).click();

  const card = page.locator(".card").first();
  await expect(card).toContainText("Ich muss die Rechnung bezahlen");
  // "muss" -> Aufgabe (siehe classify() in app/page.tsx)
  await expect(card.locator(".tag")).toHaveText("Aufgabe");
});

test("Composer-Mikro nutzt die im Dropdown gewählte Sprache", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("combobox", { name: /Sprache der Spracherkennung/i }).selectOption("es-ES");
  await page.getByRole("button", { name: /Aufnahme starten/i }).click();
  const lang = await page.evaluate(() => (window as unknown as { __activeRecognition?: { lang: string } }).__activeRecognition?.lang);
  expect(lang).toBe("es-ES");
  // Spanisch diktierter Text landet im Composer und wird abgelegt.
  await emitSpeech(page, "comprar leche para mañana");
  await expect(page.getByRole("textbox", { name: /neuen Inbox-Eintrag/i })).toHaveValue(/comprar leche/);
});

test("erfasst Sprache über den gemockten Speech-Layer", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Aufnahme starten/i }).click();
  await emitSpeech(page, "Termin morgen um 15 Uhr beim Zahnarzt");

  const textarea = page.getByRole("textbox", { name: /neuen Inbox-Eintrag/i });
  await expect(textarea).toHaveValue(/Zahnarzt/);

  await page.getByRole("button", { name: /In Inbox ablegen/i }).click();
  const card = page.locator(".card").first();
  await expect(card).toContainText("Zahnarzt");
  await expect(card.locator(".tag")).toHaveText("Termin");
});

test("filtert und durchsucht die Inbox", async ({ page }) => {
  await page.goto("/");
  const textarea = page.getByRole("textbox", { name: /neuen Inbox-Eintrag/i });
  const add = page.getByRole("button", { name: /In Inbox ablegen/i });

  await textarea.fill("Idee für ein neues Projekt");
  await add.click();
  await textarea.fill("Rechnung bezahlen erledigen");
  await add.click();

  await expect(page.locator(".card")).toHaveCount(2);

  await page.getByRole("button", { name: "Idee", exact: true }).click();
  await expect(page.locator(".card")).toHaveCount(1);
  await expect(page.locator(".card").first()).toContainText("Projekt");

  await page.getByRole("button", { name: "Alle" }).click();
  await page.getByRole("textbox", { name: /durchsuchen/i }).fill("Rechnung");
  await expect(page.locator(".card")).toHaveCount(1);
  await expect(page.locator(".card").first()).toContainText("Rechnung");
});

test("löscht einen Eintrag", async ({ page }) => {
  await page.goto("/");
  const textarea = page.getByRole("textbox", { name: /neuen Inbox-Eintrag/i });
  await textarea.fill("Testeintrag zum Löschen");
  await page.getByRole("button", { name: /In Inbox ablegen/i }).click();
  await expect(page.locator(".card")).toHaveCount(1);

  await page.locator(".card").getByRole("button", { name: "Löschen" }).click();
  await expect(page.locator(".card")).toHaveCount(0);
});

test("leert das Eingabefeld nach dem Ablegen", async ({ page }) => {
  await page.goto("/");
  const textarea = page.getByRole("textbox", { name: /neuen Inbox-Eintrag/i });
  await textarea.fill("Etwas, das gleich abgelegt wird");
  await page.getByRole("button", { name: /In Inbox ablegen/i }).click();
  await expect(textarea).toHaveValue("");
  await expect(page.getByRole("button", { name: /In Inbox ablegen/i })).toBeDisabled();
});

test("ändert die Kategorie per Klick auf den Tag", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: /neuen Inbox-Eintrag/i }).fill("Neutraler Text");
  await page.getByRole("button", { name: /In Inbox ablegen/i }).click();
  const tag = page.locator(".card").first().locator(".tag");
  await expect(tag).toHaveText("Notiz");
  await tag.click();
  await expect(tag).toHaveText("Idee"); // Notiz -> Idee (Zyklus: Aufgabe,Termin,Notiz,Idee)
  await tag.click();
  await expect(tag).toHaveText("Aufgabe");
});

test("kopiert einen Eintrag in die Zwischenablage", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.getByRole("textbox", { name: /neuen Inbox-Eintrag/i }).fill("Zu kopierender Text");
  await page.getByRole("button", { name: /In Inbox ablegen/i }).click();
  await page.locator(".card").getByRole("button", { name: "Kopieren" }).click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe("Zu kopierender Text");
});

test("schaltet zwischen Karten- und Listenansicht um", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: /neuen Inbox-Eintrag/i }).fill("Ein Eintrag");
  await page.getByRole("button", { name: /In Inbox ablegen/i }).click();
  await expect(page.locator(".card")).toHaveCount(1);
  await expect(page.locator(".row")).toHaveCount(0);

  await page.getByRole("button", { name: /Listenansicht/i }).click();
  await expect(page.locator(".row")).toHaveCount(1);
  await expect(page.locator(".card")).toHaveCount(0);
});

test("exportiert und importiert den State als JSON", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: /neuen Inbox-Eintrag/i }).fill("Export-Testeintrag");
  await page.getByRole("button", { name: /In Inbox ablegen/i }).click();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export als JSON" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("voice-inbox-export.json");

  // Import einer bekannten Datei ergänzt den Bestand (Merge über id).
  const payload = [
    { id: "imp-1", kind: "Idee", text: "Importierte Idee", created: "Importiert" },
    { id: "imp-2", kind: "Aufgabe", text: "Importierte Aufgabe", created: "Importiert" },
  ];
  await page.locator('input[type=file]').setInputFiles({
    name: "import.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(payload)),
  });
  await expect(page.locator(".card")).toHaveCount(3);
  await expect(page.locator(".card").first()).toContainText("Importierte Idee");
  await expect(page.locator(".card", { hasText: "Export-Testeintrag" })).toHaveCount(1);

  // Erneuter Import derselben Datei dupliziert nichts.
  await page.locator('input[type=file]').setInputFiles({
    name: "import.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(payload)),
  });
  await expect(page.locator(".card")).toHaveCount(3);
});

test("hakt Einträge ab und filtert nach Status", async ({ page }) => {
  await page.goto("/");
  const textarea = page.getByRole("textbox", { name: /neuen Inbox-Eintrag/i });
  await textarea.fill("Blumen gießen");
  await page.getByRole("button", { name: /In Inbox ablegen/i }).click();
  await textarea.fill("Buch zurückgeben");
  await page.getByRole("button", { name: /In Inbox ablegen/i }).click();

  await page.locator(".card", { hasText: "Blumen" }).getByRole("button", { name: "Als erledigt markieren" }).click();
  // Standardansicht "Offen" blendet Erledigtes aus.
  await expect(page.locator(".card")).toHaveCount(1);
  await expect(page.locator(".card").first()).toContainText("Buch");

  await page.getByRole("button", { name: /^Erledigt/ }).click();
  await expect(page.locator(".card")).toHaveCount(1);
  await expect(page.locator(".card.isDone")).toContainText("Blumen");

  await page.getByRole("button", { name: "Gesamt" }).click();
  await expect(page.locator(".card")).toHaveCount(2);
  // Erledigte stehen unten; wieder öffnen geht per Klick.
  await expect(page.locator(".card").last()).toContainText("Blumen");
  await page.locator(".card", { hasText: "Blumen" }).getByRole("button", { name: "Wieder öffnen" }).click();
  await expect(page.locator(".card.isDone")).toHaveCount(0);
});

test("erkennt Fälligkeiten im Text und sortiert sie nach oben", async ({ page }) => {
  await page.goto("/");
  const textarea = page.getByRole("textbox", { name: /neuen Inbox-Eintrag/i });
  await textarea.fill("Termin morgen um 15 Uhr beim Zahnarzt");
  await page.getByRole("button", { name: /In Inbox ablegen/i }).click();
  await textarea.fill("Idee ohne Datum");
  await page.getByRole("button", { name: /In Inbox ablegen/i }).click();

  const first = page.locator(".card").first();
  await expect(first).toContainText("Zahnarzt");
  await expect(first.locator(".due")).toHaveText("◷ Morgen, 15:00");

  // Wiedervorlage um einen Tag
  await first.locator(".due").click();
  await first.getByRole("button", { name: "+1 Tag" }).click();
  await expect(first.locator(".due")).toHaveText("◷ Übermorgen, 15:00");
});

test("bearbeitet den Text eines Eintrags", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: /neuen Inbox-Eintrag/i }).fill("Tippfeler im Text");
  await page.getByRole("button", { name: /In Inbox ablegen/i }).click();
  await page.locator(".card").getByRole("button", { name: "Bearbeiten" }).click();
  await page.getByRole("textbox", { name: "Eintrag bearbeiten" }).fill("Tippfehler korrigiert");
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.locator(".card .entryText")).toHaveText("Tippfehler korrigiert");
});

test("exportiert als Markdown", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: /neuen Inbox-Eintrag/i }).fill("Ich muss die Steuer machen");
  await page.getByRole("button", { name: /In Inbox ablegen/i }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export als Markdown" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("voice-inbox.md");
  const content = await (await import("node:fs/promises")).readFile(await download.path(), "utf8");
  expect(content).toContain("## Aufgabe");
  expect(content).toContain("- [ ] Ich muss die Steuer machen");
});

test("übernimmt geteilten Text (Share Target) in den Composer", async ({ page }) => {
  await page.goto("/?title=Artikel&text=Unbedingt%20lesen&url=https%3A%2F%2Fexample.com");
  await expect(page.getByRole("textbox", { name: /neuen Inbox-Eintrag/i })).toHaveValue("Artikel\nUnbedingt lesen\nhttps://example.com");
  expect(new URL(page.url()).search).toBe("");
});

test("migriert alte Einträge ohne Zeitstempel und legt ein Backup an", async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("seeded")) {
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("voice-inbox-entries", JSON.stringify([{ id: "old-1", kind: "Notiz", text: "Alter Eintrag", created: "Gerade eben" }]));
    }
  });
  await page.goto("/");
  await expect(page.locator(".card")).toContainText("Alter Eintrag");
  const stored = await page.evaluate(() => ({ entries: JSON.parse(localStorage.getItem("voice-inbox-entries") ?? "[]"), backup: localStorage.getItem("voice-inbox-entries-v1-backup") }));
  expect(stored.entries[0].createdAt).toMatch(/^\d{4}-/);
  expect(stored.backup).toContain("Alter Eintrag");
});
