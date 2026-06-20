import "dotenv/config";
import { KajasportScraper } from "../scrapers/kajasport.js";
import { extractSearchListNav } from "../scrapers/lib/searchListNav.js";

async function main() {
  const login = process.env.KAJA_LOGIN;
  const password = process.env.KAJA_PASSWORD;
  if (!login || !password)
    throw new Error("KAJA_LOGIN/KAJA_PASSWORD env vars required");

  const scraper = new KajasportScraper();
  const browser = await (scraper as any).launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    );
    await page.setExtraHTTPHeaders({ "Accept-Language": "pl-PL,pl;q=0.9" });

    console.log("Navigating to login...");
    await page.goto(`${scraper.homeUrl}/login.php`, {
      waitUntil: "domcontentloaded",
    });
    await (scraper as any).acceptCookies(page, "#acceptAll");
    try {
      await (scraper as any).clickByText(page, "button", "Potwierdzam wszystkie");
    } catch {}
    await page.type('input[name="login"]', login);
    await page.type('input[name="password"]', password);
    await (scraper as any).clickByText(page, "button", "Zaloguj się");
    await page.waitForSelector("li.nav-item");
    console.log("Logged in.");

    console.log("Flipping to list view...");
    await page.goto(`${scraper.homeUrl}/settings.php?search_display_mode=list`, {
      waitUntil: "domcontentloaded",
    });

    console.log("\nAvailable L1 nav labels:");
    const labels = await page.evaluate(() => {
      return [...document.querySelectorAll("li.nav-item")]
        .map((li) => li.querySelector("a")?.textContent?.trim())
        .filter(Boolean);
    });
    console.log(labels);

    console.log("\n========== ODZIEŻ ==========");
    const nav = await extractSearchListNav(page, "ODZIEŻ");
    for (const cat of nav) {
      console.log(`  ${cat.category} (${cat.children.length} children)`);
      for (const child of cat.children) {
        console.log(`    - ${child.category}  ->  ${child.href}`);
      }
    }
    if (nav.length === 0) {
      console.log("(empty nav — selector mismatch?)");
    }
  } finally {
    await browser.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
