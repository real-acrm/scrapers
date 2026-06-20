import "dotenv/config";
import { mkdtemp, readFile, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Page } from "puppeteer";
import { BaseScraper } from "./base.js";
import type { ScrapedProduct } from "../pipeline/types.js";
import { parseGoldensneakersWorkbook } from "./lib/goldensneakersXlsx.js";

const LOGIN_URL = "https://www.goldensneakers.net/users/login/";
const CATALOG_URL = "https://www.goldensneakers.net/warehouse/product-catalog/";
const EXPORT_HREF_SUBSTR = "/warehouse/download-stock-as-excel/";

export class GoldensneakersScraper extends BaseScraper {
  readonly id = "goldensneakers";
  readonly displayName = "Golden Sneakers";
  readonly homeUrl = "https://www.goldensneakers.net";

  async *scrape(): AsyncGenerator<ScrapedProduct> {
    const login = process.env.GOLDENSNEAKERS_LOGIN;
    const password = process.env.GOLDENSNEAKERS_PASSWORD;
    if (!login || !password)
      throw new Error(
        "GOLDENSNEAKERS_LOGIN/GOLDENSNEAKERS_PASSWORD env vars required",
      );

    const browser = await this.launchBrowser();
    try {
      const page = await browser.newPage();
      await page.setUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      );

      console.log(`[${this.id}] logging in...`);
      await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#id_username", { timeout: 15000 });
      await page.type("#id_username", login, { delay: 30 });
      await page.type("#id_password", password, { delay: 30 });
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }),
        page.evaluate(() => {
          const form = [...document.querySelectorAll("form")].find((f) =>
            f.querySelector("#id_username"),
          ) as HTMLFormElement | undefined;
          if (form) form.submit();
        }),
      ]);
      if (page.url().includes("/users/login/")) {
        throw new Error(`[${this.id}] login failed (still on /users/login/)`);
      }
      console.log(`[${this.id}] logged in (url=${page.url()})`);

      // The export endpoint sits behind the same session cookies — visit the
      // catalog page once so any setup cookies it sets are present too.
      await page.goto(CATALOG_URL, { waitUntil: "domcontentloaded" });

      const buf = await this.downloadExport(page);
      console.log(`[${this.id}] downloaded catalog (${buf.byteLength} bytes)`);

      for (const product of parseGoldensneakersWorkbook(buf)) {
        yield product;
      }
    } finally {
      await browser.close();
    }
  }

  /**
   * Drive the actual "Excel" button via the real browser so the download looks
   * like a normal click (correct Referer + sec-fetch-* headers + cookies the
   * browser already holds). We capture the file via CDP's
   * Browser.setDownloadBehavior to a temp dir.
   */
  private async downloadExport(page: Page): Promise<ArrayBuffer> {
    const dir = await mkdtemp(join(tmpdir(), "gs-export-"));
    const session = await page.createCDPSession();
    try {
      await session.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: dir,
        eventsEnabled: true,
      } as never);

      const completed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("export download timed out after 90s")),
          90_000,
        );
        session.on("Browser.downloadProgress", (e: { state?: string }) => {
          if (e.state === "completed") {
            clearTimeout(timer);
            resolve();
          } else if (e.state === "canceled") {
            clearTimeout(timer);
            reject(new Error("export download canceled"));
          }
        });
      });

      const clicked = await page.evaluate((hrefSubstr: string) => {
        const a = [...document.querySelectorAll("a")].find((x) =>
          (x.getAttribute("href") || "").includes(hrefSubstr),
        ) as HTMLAnchorElement | undefined;
        if (!a) return false;
        a.click();
        return true;
      }, EXPORT_HREF_SUBSTR);
      if (!clicked) {
        throw new Error(
          `[${this.id}] Excel button not found on ${CATALOG_URL}`,
        );
      }

      await completed;
      const files = await readdir(dir);
      const xlsx = files.find((f) => f.endsWith(".xlsx")) ?? files[0];
      if (!xlsx) throw new Error(`[${this.id}] no file appeared in ${dir}`);
      const buf = await readFile(join(dir, xlsx));
      // Slice into a fresh ArrayBuffer for the parser.
      return buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
      ) as ArrayBuffer;
    } finally {
      await session.detach().catch(() => {});
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
