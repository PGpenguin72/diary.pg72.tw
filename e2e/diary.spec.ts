import { expect, test } from "@playwright/test";
import {
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipWriter,
} from "@zip.js/zip.js";

const syntheticEntry = `<!doctype html>
<html><body>
<p class="p1"><span class="s1"><div class="pageContainer">
<div class="pageHeader">Sunday, 3 November 2024</div>
<div class="assetGrid">
  <div id="PHOTO1" class="gridItem assetType_photo">
    <img src="../Resources/PHOTO1.jpeg" class="asset_image" />
  </div>
  <div id="PHOTO2" class="gridItem assetType_photo">
    <img src="../Resources/PHOTO2.png" class="asset_image" />
  </div>
  <div id="VIDEO1" class="gridItem assetType_video">
    <video><source src="../Resources/VIDEO1.mov" /></video>
  </div>
  <div id="AUDIO1" class="gridItem assetType_audio">
    <div class="audioAssetHeader">Voice note</div>
  </div>
</div>
<div class="title">合成的 Apple Journal 日記</div><div class="bodyText"></span></p>
<p class="p2"><span class="s2">這是一篇只用於匯入測試的合成內容。</span></p>
<p class="p1"><span class="s1"></div></div></span></p>
</body></html>`;

const onePixelPng = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

const syntheticFtypMedia = new Uint8Array([
  0x00, 0x00, 0x00, 0x0c, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20,
]);

async function syntheticAppleJournalZip(): Promise<Buffer> {
  const output = new Uint8ArrayWriter();
  const writer = new ZipWriter(output);
  await writer.add(
    "AppleJournalEntries/Entries/2024-11-03.html",
    new TextReader(syntheticEntry),
  );
  await writer.add(
    "AppleJournalEntries/Resources/PHOTO1.jpeg",
    new Uint8ArrayReader(onePixelPng),
  );
  await writer.add(
    "AppleJournalEntries/Resources/PHOTO2.png",
    new Uint8ArrayReader(onePixelPng),
  );
  await writer.add(
    "__MACOSX/AppleJournalEntries/Entries/._2024-11-03.html",
    new Uint8ArrayReader(new Uint8Array([0x00, 0x05, 0x16, 0x07])),
  );
  await writer.add(
    "AppleJournalEntries/Resources/VIDEO1.mov",
    new Uint8ArrayReader(syntheticFtypMedia),
  );
  await writer.add(
    "AppleJournalEntries/Resources/AUDIO1.m4a",
    new Uint8ArrayReader(syntheticFtypMedia),
  );
  return Buffer.from(await writer.close());
}

test("overview renders without horizontal overflow", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("最近的日子")).toBeVisible();
  await expect(page.getByText("沒有符合的日記")).toBeVisible();
  await expect(page.locator(".entry-card")).toHaveCount(0);

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

test("@desktop entry, composer, and import surfaces are usable", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByText("沒有符合的日記")).toBeVisible();

  await page.getByRole("button", { name: "新增日記" }).click();
  const composeDialog = page.getByRole("dialog", { name: "寫下今天" });
  await composeDialog.getByLabel("標題").fill("Playwright 留下的一頁");
  await composeDialog.getByLabel("內容").fill("這是一篇由端到端測試建立的合成日記。沒有任何真實個人資料。");
  await composeDialog.getByLabel("地點").fill("本機測試環境");
  await composeDialog.getByRole("button", { name: "取消" }).click();
  await expect(composeDialog).toBeHidden();

  await page.getByRole("button", { name: "匯入" }).click();
  const importDialog = page.getByRole("dialog", { name: "匯入日記" });
  const archive = await syntheticAppleJournalZip();
  await importDialog.locator('input[type="file"]').setInputFiles({
    name: "AppleJournalEntries.zip",
    mimeType: "application/zip",
    buffer: archive,
  });
  await expect(importDialog.getByText("1 篇日記可以匯入")).toBeVisible();
  await expect(importDialog.getByText("4 個媒體", { exact: false })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("import-preview.png") });
  await importDialog.getByRole("button", { name: "開始匯入" }).click();
  await expect(importDialog.getByText("匯入完成")).toBeVisible();
  await expect(importDialog.getByText("1 篇已寫入", { exact: false })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("import-complete.png") });
  await importDialog.getByRole("button", { name: "完成" }).click();

  await page.getByPlaceholder("搜尋日記").fill("合成的 Apple Journal 日記");
  await expect(page.getByText("合成的 Apple Journal 日記")).toBeVisible();
  const importedCard = page.locator(".entry-card").filter({ hasText: "合成的 Apple Journal 日記" });
  const firstCoverSource = await importedCard.locator("img").getAttribute("src");
  await importedCard.getByRole("button", { name: "下一張封面" }).click();
  await expect(importedCard.locator("img")).not.toHaveAttribute("src", firstCoverSource ?? "");
  expect(await importedCard.locator("img").evaluate((image) => getComputedStyle(image).objectFit)).toBe("contain");
  await importedCard.locator(".entry-card__open").click();
  const importedDetail = page.getByRole("dialog", { name: "合成的 Apple Journal 日記" });
  await expect(importedDetail.locator("video")).toHaveCount(1);
  await expect(importedDetail.locator("audio")).toHaveCount(1);
  await expect(importedDetail.locator("img")).toHaveCount(2);
  const importedImageType = await importedDetail.locator("img").first().evaluate(async (element) => {
    const image = element as HTMLImageElement;
    const response = await fetch(image.currentSrc);
    return response.headers.get("Content-Type");
  });
  expect(importedImageType).toBe("image/png");
  await page.screenshot({ path: testInfo.outputPath("imported-media.png") });
  await importedDetail.getByTitle("關閉").click();
  await page.getByPlaceholder("搜尋日記").fill("");

  await page.getByRole("button", { name: "匯入" }).click();
  const repeatedImport = page.getByRole("dialog", { name: "匯入日記" });
  await repeatedImport.locator('input[type="file"]').setInputFiles({
    name: "AppleJournalEntries.zip",
    mimeType: "application/zip",
    buffer: archive,
  });
  await repeatedImport.getByRole("button", { name: "開始匯入" }).click();
  await expect(repeatedImport.getByText("0 篇已寫入 · 1 篇重複")).toBeVisible();
});
