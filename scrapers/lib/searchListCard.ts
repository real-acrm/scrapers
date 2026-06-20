import type { ScrapedProduct, ScrapedVariant } from "../../pipeline/types.js";

export type RawFlatVariant = {
  name: string;
  price: number | null;
  lowestPrice?: number;
  regularPrice?: number;
  srp?: number;
  stock: number;
};

export type RawMultiVariant = {
  name: string;
  price: number | null;
  lowestPrice?: number;
  regularPrice?: number;
  srp?: number;
  subvariants: { name: string; stock: number }[];
};

export type RawProductCard = {
  image: string | null;
  labels: string[];
  title: string | null;
  brand: string | null;
  symbol: string | null;
  href?: string;
  variants: (RawFlatVariant | RawMultiVariant)[];
};

/**
 * Runs in the browser via card.evaluate. Parses one .search_list__product card
 * from the shared Polish B2B e-commerce engine used by naleo / kajasport.
 */
export function parseSearchListCard(productEl: Element): RawProductCard | null {
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

  if (!title || !symbol) return null;

  const variantBlocks = productEl.querySelectorAll(".search_versions__block");
  const firstSub = variantBlocks[0]?.querySelector(
    ".search_versions__sub",
  ) as HTMLElement | null;
  const isFlat = !!firstSub?.dataset?.size;

  if (isFlat) {
    const href =
      (productEl.querySelector(".search_top__name") as HTMLAnchorElement)
        ?.href ?? "";
    const variants: RawFlatVariant[] = [];

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

      const rawSrp = block
        .querySelector(".search_prices__srp")
        ?.textContent?.trim();
      const srp = rawSrp
        ? parseFloat(
            rawSrp
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
        ...(srp !== undefined && !isNaN(srp) && { srp }),
        stock,
      });
    });

    return { image, labels, title, brand, symbol, href, variants };
  }

  const variantsMap = new Map<string, RawMultiVariant>();

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

      const rawSrp = sub
        ?.querySelector(".search_prices__srp")
        ?.textContent?.trim();
      const srp = rawSrp
        ? parseFloat(
            rawSrp
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
        ...(srp !== undefined && !isNaN(srp) && { srp }),
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

  const href =
    (productEl.querySelector(".search_top__name") as HTMLAnchorElement)?.href ??
    "";

  return {
    image,
    labels,
    title,
    brand,
    symbol,
    href,
    variants: [...variantsMap.values()],
  };
}

export function toScrapedProduct(
  raw: RawProductCard,
  ctx: { wholesalerId: string; categoryPath: string[] },
): ScrapedProduct {
  const variants: ScrapedVariant[] = [];
  for (const v of raw.variants) {
    if ("subvariants" in v) {
      for (const sub of v.subvariants) {
        variants.push({
          optionValues: [
            { optionName: "Kolor", value: v.name },
            { optionName: "Rozmiar", value: sub.name },
          ],
          price: v.price,
          lowestPrice: v.lowestPrice,
          regularPrice: v.regularPrice,
          srp: v.srp,
          stock: sub.stock,
        });
      }
    } else {
      variants.push({
        optionValues: [{ optionName: "Wariant", value: v.name }],
        price: v.price,
        lowestPrice: v.lowestPrice,
        regularPrice: v.regularPrice,
        srp: v.srp,
        stock: v.stock,
      });
    }
  }
  return {
    wholesalerId: ctx.wholesalerId,
    symbol: raw.symbol!,
    name: raw.title!,
    brand: raw.brand,
    image: raw.image,
    href: raw.href ?? null,
    labels: raw.labels,
    categoryPath: ctx.categoryPath,
    variants,
  };
}
