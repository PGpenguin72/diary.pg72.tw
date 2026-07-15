import { expect, test } from "@playwright/test";

test("overview renders without horizontal overflow", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("最近的日子")).toBeVisible();
  await expect(page.locator(".entry-card").first()).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(pageErrors).toEqual([]);

  if (testInfo.project.name === "mobile") {
    await expect(page.locator(".mobile-nav")).toBeVisible();
  } else {
    await expect(page.locator(".sidebar")).toBeVisible();
  }

  await page.screenshot({
    path: testInfo.outputPath("overview.png"),
    fullPage: true,
  });
});

test("@desktop entry, composer, and import surfaces are usable", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".entry-card").first()).toBeVisible();

  await page.locator(".entry-card__open").first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".entry-prose")).toBeVisible();
  await page.getByTitle("關閉").click();

  await page.getByRole("button", { name: "新增日記" }).click();
  const composeDialog = page.getByRole("dialog", { name: "寫下今天" });
  await composeDialog.getByLabel("標題").fill("Playwright 留下的一頁");
  await composeDialog.getByLabel("內容").fill("這是一篇由端到端測試建立的合成日記。沒有任何真實個人資料。");
  await composeDialog.getByLabel("地點").fill("本機測試環境");
  await composeDialog.getByRole("button", { name: "取消" }).click();
  await expect(composeDialog).toBeHidden();

  await page.getByRole("button", { name: "匯入" }).click();
  const importDialog = page.getByRole("dialog", { name: "匯入日記" });
  await importDialog.locator('input[type="file"]').setInputFiles({
    name: "AppleJournalEntries.zip",
    mimeType: "application/zip",
    buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]),
  });
  await expect(importDialog.getByText("基本格式檢查完成")).toBeVisible();
  await expect(importDialog.getByText("尚未寫入日記", { exact: false })).toBeVisible();
});
