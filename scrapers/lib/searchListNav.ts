import type { ElementHandle, Page } from "puppeteer";

export type NavCategory = {
  category: string;
  href: string;
  children: { category: string; href: string }[];
  topCategory: string;
};

/**
 * Hovers the L1 menu entry whose visible text matches `label`, then reads
 * the L2/L3 tree from `ul.navbar-subnav`. Works for the shared Polish B2B
 * engine used by naleo / kajasport.
 */
export async function extractSearchListNav(
  page: Page,
  label: string,
): Promise<NavCategory[]> {
  const navItem = await page.evaluateHandle((label) => {
    return [...document.querySelectorAll("li.nav-item")].find(
      (li) => li.querySelector("a")?.textContent?.trim() === label,
    );
  }, label);
  const elementHandle = navItem.asElement() as ElementHandle<Element> | null;
  if (elementHandle) {
    await elementHandle.hover();
  }
  await page.waitForSelector("ul.navbar-subnav");

  const data = await page.evaluate((label) => {
    const allSubnavs = document.querySelectorAll("ul.navbar-subnav");
    let element: Element | null = null;
    for (const nav of allSubnavs) {
      const l1Link = nav.querySelector(".nav-link.--l1");
      if (l1Link?.textContent?.trim() === label) {
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
        const href = (l2 as HTMLAnchorElement).href;
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
        return { category, href, children };
      });
  }, label);

  return data.map((e) => ({ ...e, topCategory: label }));
}
