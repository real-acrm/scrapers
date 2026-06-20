import "dotenv/config";
import { NaleoScraper } from "../scrapers/naleo.js";

async function main() {
  const login = process.env.LOGIN;
  const password = process.env.PASSWORD;
  if (!login || !password) throw new Error("LOGIN/PASSWORD env vars required");

  const scraper = new NaleoScraper();
  const browser = await (scraper as any).launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    );
    await page.setExtraHTTPHeaders({ "Accept-Language": "pl-PL,pl;q=0.9" });

    console.log("Navigating to login...");
    await page.goto(`${scraper.homeUrl}/index.php`, {
      waitUntil: "domcontentloaded",
    });
    await (scraper as any).acceptCookies(page, "#acceptAll");
    await page.type('input[name="login"]', login);
    await page.type('input[name="password"]', password);
    await (scraper as any).clickByText(page, "button", "Log in");
    await page.waitForSelector("li.nav-item");

    const sections = ["Kobieta", "Mężczyzna", "Dziecko", "Akcesoria"];
    for (const label of sections) {
      console.log(`\n========== ${label} ==========`);
      const nav = await (scraper as any).extractNav(page, label);
      for (const cat of nav) {
        console.log(`  ${cat.category} (${cat.children.length} children)`);
        for (const child of cat.children) {
          console.log(`    - ${child.category}  ->  ${child.href}`);
        }
      }
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
