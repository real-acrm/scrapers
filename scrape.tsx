import "dotenv/config";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import * as fs from "fs";
import { Page } from "puppeteer";

const LOGIN = process.env.LOGIN;
const PASSWORD = process.env.PASSWORD;

puppeteer.use(StealthPlugin());

if (!LOGIN || !PASSWORD) {
  console.error("Missing LOGIN or PASSWORD in .env");
  process.exit(1);
}

function parseProduct(productEl: Element) {
  const image =
    (productEl.querySelector(".search_top__icon img") as HTMLImageElement)
      ?.src ?? null;

  const labels = [...productEl.querySelectorAll(".label_icons .label")].map(
    (el) => el.textContent!.trim().toUpperCase(),
  );

  const title =
    productEl.querySelector(".search_top__name_text")?.textContent?.trim() ??
    null;
  const brand =
    productEl
      .querySelector(".search_top__param.--firm .search_top__param_value")
      ?.textContent?.trim() ?? null;
  const symbol =
    productEl
      .querySelector(".search_top__param.--code .search_top__param_value")
      ?.textContent?.trim() ?? null;

  const variantBlocks = productEl.querySelectorAll(".search_versions__block");

  const firstSub = variantBlocks[0]?.querySelector(
    ".search_versions__sub",
  ) as HTMLElement | null;
  const isFlat = !!firstSub?.dataset?.size;

  if (isFlat) {
    const href =
      (productEl.querySelector(".search_top__name") as HTMLAnchorElement)
        ?.href ?? "";
    const variants: {
      name: string;
      price: number | null;
      lowestPrice?: number;
      regularPrice?: number;
      stock: number;
    }[] = [];

    variantBlocks.forEach((block) => {
      const name = block
        .querySelector(".search_versions__label_text")
        ?.textContent?.trim();
      if (!name) return;

      const priceValueEl = block.querySelector(".search_versions__price_value");
      const rawPrice = priceValueEl
        ? priceValueEl.textContent!.trim()
        : block.querySelector(".search_versions__price")?.textContent?.trim();
      const price = rawPrice
        ? parseFloat(
            rawPrice
              .match(/[\d\s]+,\d+/)?.[0]
              ?.replace(/\s/g, "")
              .replace(",", ".") ?? "",
          )
        : null;

      const rawLowest = block
        .querySelector(".omnibus_price__value")
        ?.textContent?.trim();
      const lowestPrice = rawLowest
        ? parseFloat(
            rawLowest
              .match(/[\d\s]+,\d+/)?.[0]
              ?.replace(/\s/g, "")
              .replace(",", ".") ?? "",
          )
        : undefined;

      const rawRegular = block
        .querySelector(".search_versions__maxprice del")
        ?.textContent?.trim();
      const regularPrice = rawRegular
        ? parseFloat(
            rawRegular
              .match(/[\d\s]+,\d+/)?.[0]
              ?.replace(/\s/g, "")
              .replace(",", ".") ?? "",
          )
        : undefined;

      const isUnavailable = !!block.querySelector(
        ".search_versions__status_description",
      );
      const stockText =
        block
          .querySelector(".search_versions__status_amount_mw")
          ?.textContent?.trim() ?? "";
      const stock = isUnavailable
        ? 0
        : parseInt(stockText.match(/(\d+)/)?.[1] ?? "0", 10);

      variants.push({
        name,
        price: price === null || isNaN(price) ? null : price,
        ...(lowestPrice !== undefined &&
          !isNaN(lowestPrice) && { lowestPrice }),
        ...(regularPrice !== undefined &&
          !isNaN(regularPrice) && { regularPrice }),
        stock,
      });
    });

    return { image, labels, title, brand, symbol, href, variants };
  }

  const variantsMap = new Map<
    string,
    {
      name: string;
      price: number | null;
      lowestPrice?: number;
      regularPrice?: number;
      subvariants: { name: string; stock: number }[];
    }
  >();

  variantBlocks.forEach((block) => {
    const productId = (block as HTMLElement).dataset.id;
    if (!productId) return;

    if (!variantsMap.has(productId)) {
      const name =
        block
          .querySelector(".search_versions__sub .search_versions__label_text")
          ?.textContent?.trim() ?? "";

      const sub = block.querySelector(".search_versions__sub");
      const priceValueEl = sub?.querySelector(".search_versions__price_value");
      const rawPrice = priceValueEl
        ? priceValueEl.textContent!.trim()
        : sub?.querySelector(".search_versions__price")?.textContent?.trim();
      const price = rawPrice
        ? parseFloat(
            rawPrice
              .match(/[\d\s]+,\d+/)?.[0]
              ?.replace(/\s/g, "")
              .replace(",", ".") ?? "",
          )
        : null;

      const rawLowest = sub
        ?.querySelector(".omnibus_price__value")
        ?.textContent?.trim();
      const lowestPrice = rawLowest
        ? parseFloat(
            rawLowest
              .match(/[\d\s]+,\d+/)?.[0]
              ?.replace(/\s/g, "")
              .replace(",", ".") ?? "",
          )
        : undefined;

      const rawRegular = sub
        ?.querySelector(".search_versions__maxprice del")
        ?.textContent?.trim();
      const regularPrice = rawRegular
        ? parseFloat(
            rawRegular
              .match(/[\d\s]+,\d+/)?.[0]
              ?.replace(/\s/g, "")
              .replace(",", ".") ?? "",
          )
        : undefined;

      variantsMap.set(productId, {
        name,
        price: price === null || isNaN(price) ? null : price,
        ...(lowestPrice !== undefined &&
          !isNaN(lowestPrice) && { lowestPrice }),
        ...(regularPrice !== undefined &&
          !isNaN(regularPrice) && { regularPrice }),
        subvariants: [],
      });
    }

    block.querySelectorAll(".search_versions__size").forEach((sizeRow) => {
      const sizeLabel = sizeRow
        .querySelector(".search_versions__label_text")
        ?.textContent?.trim();
      if (!sizeLabel) return;

      const isDisabled = (sizeRow as HTMLElement).dataset.disabled === "true";
      const isUnavailable = !!sizeRow.querySelector(
        ".search_versions__status_description",
      );
      const stockText =
        sizeRow
          .querySelector(".search_versions__status_amount_mw")
          ?.textContent?.trim() ?? "";
      const stock =
        isDisabled || isUnavailable
          ? 0
          : parseInt(stockText.match(/(\d+)/)?.[1] ?? "0", 10);

      variantsMap.get(productId)!.subvariants.push({ name: sizeLabel, stock });
    });
  });

  return {
    image,
    labels,
    title,
    brand,
    symbol,
    variants: [...variantsMap.values()],
  };
}

async function waitForText(
  page: any,
  tag: string,
  text: string,
  timeout = 30000,
) {
  await page.waitForFunction(
    ({ tag, text }: { tag: string; text: string }) =>
      [...document.querySelectorAll(tag)].some(
        (el) => el.textContent?.trim() === text,
      ),
    { timeout },
    { tag, text },
  );
}

async function clickByText(page: any, tag: string, text: string) {
  const el = await page
    .locator(`::-p-xpath(//${tag}[normalize-space()="${text}"])`)
    .waitHandle();
  if (!el) throw new Error(`Element <${tag}> with text "${text}" not found`);
  await el.evaluate((node: HTMLElement) => node.click()); // ← this line changed
}

export async function parsePage(onFinish: (products: any[]) => Promise<void>) {
  return await puppeteer
    .launch({
      headless: false,
      defaultViewport: { width: 1280, height: 900 },
      args: ["--no-sandbox"],
    })
    .then(async (browser) => {
      const page = await browser.newPage();
      await page.setUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      );
      await page.setExtraHTTPHeaders({ "Accept-Language": "pl-PL,pl;q=0.9" });
      const allProducts: any[] = [];

      try {
        // Navigate to login page
        console.log("Navigating to login page...");
        await page.goto("https://b2b-naleo.pl/index.php", {
          waitUntil: "domcontentloaded",
        });

        // Accept cookies
        // get by id acceptAll
        const cookieBtn = await page.waitForSelector("#acceptAll", {
          timeout: 10000,
        });
        if (cookieBtn) await cookieBtn.click();
        console.log("Accepted cookie consent.");

        // Log in
        console.log("Logging in...");
        await page.type('input[name="login"]', LOGIN!);
        await page.type('input[name="password"]', PASSWORD!);
        await clickByText(page, "button", "Log in");

        // Wait for nav to be ready after login
        await page.waitForSelector("li.nav-item");

        // Find and hover the Kobieta nav item
        const kobietaLi = await page.evaluateHandle(() => {
          return [...document.querySelectorAll("li.nav-item")].find(
            (li) => li.querySelector("a")?.textContent?.trim() === "Kobieta",
          );
        });
        if (kobietaLi) {
          await (kobietaLi as any).hover();
        }
        // parse subnav in browser context
        await page.waitForSelector("ul.navbar-subnav");
        const womenNavbarData = (
          await page.evaluate(() => {
            const element = document.querySelector("ul.navbar-subnav");
            if (!element) return [];
            const seen = new Set<string>();
            return Array.from(element.querySelectorAll(".nav-link.--l2"))
              .filter((l2) => {
                const category = l2.textContent?.trim() ?? "";
                if (seen.has(category)) return false;
                seen.add(category);
                return true;
              })
              .map((l2) => {
                const category = l2.textContent?.trim() ?? "";
                const subNav = l2
                  .closest(".nav-item")
                  ?.querySelector(".navbar-subsubnav");
                const children = Array.from(
                  subNav?.querySelectorAll(".nav-link.--l3") ?? [],
                )
                  .filter((l3) => !l3.closest(".nav-item.--extend"))
                  .map((l3) => ({
                    category: l3.textContent?.trim() ?? "",
                    href: (l3 as HTMLAnchorElement).href,
                  }));
                return { category, children };
              });
          })
        ).map((e) => ({ ...e, gender: "women" as const }));

        // Find and hover the Mężczyzna nav item
        const menLi = await page.evaluateHandle(() => {
          return [...document.querySelectorAll("li.nav-item")].find(
            (li) => li.querySelector("a")?.textContent?.trim() === "Mężczyzna",
          );
        });
        if (menLi) {
          await (menLi as any).hover();
        }
        await page.waitForSelector("ul.navbar-subnav");
        const menNavbarData = (
          await page.evaluate(() => {
            const allSubnavs = document.querySelectorAll("ul.navbar-subnav");
            let element: Element | null = null;
            for (const nav of allSubnavs) {
              const l1Link = nav.querySelector(".nav-link.--l1");
              if (l1Link?.textContent?.trim() === "Mężczyzna") {
                element = nav;
                break;
              }
            }
            if (!element) return [];
            const seen = new Set<string>();
            return Array.from(element.querySelectorAll(".nav-link.--l2"))
              .filter((l2) => {
                const category = l2.textContent?.trim() ?? "";
                if (seen.has(category)) return false;
                seen.add(category);
                return true;
              })
              .map((l2) => {
                const category = l2.textContent?.trim() ?? "";
                const subNav = l2
                  .closest(".nav-item")
                  ?.querySelector(".navbar-subsubnav");
                const children = Array.from(
                  subNav?.querySelectorAll(".nav-link.--l3") ?? [],
                )
                  .filter((l3) => !l3.closest(".nav-item.--extend"))
                  .map((l3) => ({
                    category: l3.textContent?.trim() ?? "",
                    href: (l3 as HTMLAnchorElement).href,
                  }));
                return { category, children };
              });
          })
        ).map((e) => ({ ...e, gender: "men" as const }));

        console.log(
          JSON.stringify(womenNavbarData, null, 2),
          JSON.stringify(menNavbarData, null, 2),
        );

        // go through paginate for all categories
        for (const category of [...womenNavbarData, ...menNavbarData]) {
          for (const child of category.children) {
            await page.goto(`${child.href}?portions=300`, {
              waitUntil: "domcontentloaded",
            });
            await page.waitForSelector(".search_list__product", {
              timeout: 30000,
            });
            await paginate(page, async (products) => {
              allProducts.push(
                ...products.map((e) => ({
                  ...e,
                  category1: category.category,
                  category2: child.category,
                  gender: category.gender,
                })),
              );
            });
          }
        }

        await onFinish(allProducts);
      } catch (error) {
        console.error("Error during scraping:", error);
        if (allProducts.length > 0) {
          fs.writeFileSync("output.json", JSON.stringify(allProducts, null, 2));
          console.log(`Saved ${allProducts.length} products before error.`);
        }
      } finally {
        await browser.close();
      }

      console.log(
        `\nDone. Total products scraped: ${allProducts.length}. Saved to output.json`,
      );
    });
}

async function paginate(
  page: Page,
  onFinish: (products: any[]) => Promise<void>,
) {
  const allProducts: any[] = [];
  let pageNum = 1;

  while (true) {
    console.log(`\n========== Scraping page ${pageNum} ==========`);

    const products = await page.$$(".search_list__product");
    console.log(`Found ${products.length} products on page ${pageNum}`);

    // Scroll through products to trigger lazy loading
    for (let i = 0; i < products.length; i++) {
      const product = products[i];
      await product.evaluate((el: Element) => {
        const rect = el.getBoundingClientRect();
        const bottomY = rect.bottom + window.scrollY + 50;
        window.scrollTo({ top: bottomY, behavior: "smooth" });
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await waitForNetworkIdle(page);
    }

    // Expand "more sizes" on each product
    for (let i = products.length - 1; i >= 0; i--) {
      const product = products[i];

      await product.evaluate((el: Element) => {
        const rect = el.getBoundingClientRect();
        const bottomY = rect.bottom + window.scrollY + 50;
        window.scrollTo({ top: bottomY, behavior: "smooth" });
      });

      const expandBtn = await product.$("span.search_versions_toggle__show");
      if (expandBtn && (await expandBtn.isVisible())) {
        await expandBtn.click();
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
      await waitForNetworkIdle(page);

      const moreSizesBtn = await product.$("a[href='#moreSizes']");
      if (moreSizesBtn && (await moreSizesBtn.isVisible())) {
        await moreSizesBtn.click();
      }
    }

    // Parse each product
    for (let i = 0; i < products.length; i++) {
      const product = products[i];

      await product.evaluate((el: Element) => {
        const rect = el.getBoundingClientRect();
        const bottomY = rect.bottom + window.scrollY + 50;
        window.scrollTo({ top: bottomY, behavior: "smooth" });
      });

      try {
        const data = await product.evaluate(parseProduct);
        console.log(
          `Product ${i + 1}/${products.length}: "${data.title}" — ${data.variants.length} variant(s)`,
        );
        allProducts.push(data);
      } catch (e) {
        console.error(
          `Product ${i + 1}/${products.length}: error parsing: ${e}`,
        );
      }
    }

    // Try to go to next page
    let hasNext = false;
    try {
      const nextBtn = await page.$(
        "li.pagination__element.--next:not(.--disabled) a.pagination__link",
      );
      if (nextBtn) {
        hasNext = true;
        await Promise.all([
          page.waitForNavigation({
            waitUntil: "domcontentloaded",
            timeout: 30000,
          }),
          nextBtn.evaluate((el: HTMLElement) => el.click()),
        ]);
        await page.waitForSelector(".search_list__product", {
          timeout: 30000,
        });
      }
    } catch {
      // no next button
    }

    if (!hasNext) {
      console.log("No more pages. Scraping complete.");
      await onFinish(allProducts);
      break;
    }

    pageNum++;
  }
}

async function waitForNetworkIdle(page: Page, timeout = 30000, idleTime = 500) {
  let inFlight = 0;

  const onRequest = (req: any) => {
    if (req.url().includes("/graphql/v1/")) inFlight++;
  };
  const onDone = (req: any) => {
    if (req.url().includes("/graphql/v1/")) inFlight--;
  };

  page.on("request", onRequest);
  page.on("requestfinished", onDone);
  page.on("requestfailed", onDone);

  try {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        console.warn("waitForNetworkIdle: timed out, continuing anyway");
        resolve(); // ← resolve, not reject
      }, timeout);

      const check = setInterval(() => {
        if (inFlight === 0) {
          clearInterval(check);
          clearTimeout(timer);
          resolve();
        }
      }, idleTime);
    });
  } finally {
    page.off("request", onRequest);
    page.off("requestfinished", onDone);
    page.off("requestfailed", onDone);
  }
}
