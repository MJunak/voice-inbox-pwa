import { test, expect, type Browser, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installNeedleMock } from "./helpers";

// Zwei "Geräte" (getrennte Browser-Kontexte) synchronisieren über den echten
// Python-Sync-Server aus server/. Braucht python3 im PATH.
const PORT = 8799;
const TOKEN = "e2e-token";
const API = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
const remote = async () => (await (await fetch(`${API}/v1/entries`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json()).entries as Array<{ text: string; done?: boolean; deletedAt?: string }>;

test.beforeAll(async () => {
  server = spawn("python3", ["server/server.py"], {
    env: { ...process.env, API_TOKEN: TOKEN, DB_PATH: join(mkdtempSync(join(tmpdir(), "vi-sync-")), "db.sqlite"), PORT: String(PORT) },
    stdio: "inherit",
  });
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`${API}/health`)).ok) return; } catch { /* startet noch */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Sync-Server startet nicht");
});
test.afterAll(() => { server?.kill(); });

async function device(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await installNeedleMock(page, []);
  await page.addInitScript(({ url, token }) => {
    if (!localStorage.getItem("voice-inbox-sync")) localStorage.setItem("voice-inbox-sync", JSON.stringify({ url, token }));
  }, { url: API, token: TOKEN });
  await page.goto("/");
  return page;
}

test("Einträge, Erledigt-Status und Löschungen wandern zwischen Geräten", async ({ browser }) => {
  const phone = await device(browser);
  const laptop = await device(browser);

  await phone.getByRole("textbox", { name: /neuen Inbox-Eintrag/i }).fill("Vom Handy diktiert");
  await phone.getByRole("button", { name: /In Inbox ablegen/i }).click();
  await expect.poll(async () => (await remote()).length).toBe(1);
  await expect(phone.locator(".syncButton")).toHaveText("VPS aktuell");

  // Laptop holt beim Zurückkehren in die App (visibilitychange) ab.
  await laptop.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(laptop.locator(".card", { hasText: "Vom Handy diktiert" })).toHaveCount(1);

  // Laptop hakt ab und legt selbst etwas an.
  await laptop.locator(".card", { hasText: "Vom Handy" }).getByRole("button", { name: "Als erledigt markieren" }).click();
  await laptop.getByRole("textbox", { name: /neuen Inbox-Eintrag/i }).fill("Vom Laptop");
  await laptop.getByRole("button", { name: /In Inbox ablegen/i }).click();
  await expect.poll(async () => (await remote()).map((e) => `${e.text}:${!!e.done}`).sort()).toEqual(["Vom Handy diktiert:true", "Vom Laptop:false"]);

  await phone.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(phone.locator(".card", { hasText: "Vom Laptop" })).toHaveCount(1);
  await expect(phone.locator(".card", { hasText: "Vom Handy" })).toHaveCount(0); // erledigt -> ausgeblendet

  // Gelöschtes kommt nicht zurück.
  await phone.locator(".card", { hasText: "Vom Laptop" }).getByRole("button", { name: "Löschen" }).click();
  await expect.poll(async () => (await remote()).filter((e) => e.deletedAt).length).toBe(1);
  await laptop.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(laptop.locator(".card", { hasText: "Vom Laptop" })).toHaveCount(0);
  await laptop.reload();
  await expect(laptop.locator(".card", { hasText: "Vom Laptop" })).toHaveCount(0);
});

test("falsches Token meldet einen Sync-Fehler", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await installNeedleMock(page, []);
  await page.goto("/");
  await page.locator(".syncButton").click();
  await page.getByLabel("API-Adresse").fill(API);
  await page.getByLabel("Zugangs-Token").fill("falsch");
  await page.getByRole("button", { name: /Speichern & synchronisieren/ }).click();
  await expect(page.locator(".syncButton")).toHaveText("Sync-Fehler");
  await expect(page.locator(".notice")).toContainText("Token ungültig");
});
