// Thin Meilisearch client for the brandsgateway scraper. Single function:
// paginate one index with limit=1000 until exhausted, mapping each hit to
// whatever shape the caller wants. No SDK dependency — the multi-search
// endpoint is just one POST.

export async function* paginateIndex<T>(opts: {
  host: string;
  token: string;
  indexUid: string;
  batch?: number;
  mapHit: (hit: Record<string, unknown>) => T | null;
  onFirstResponse?: (meta: { estimatedTotalHits: number | null }) => void;
}): AsyncGenerator<T> {
  const batch = opts.batch ?? 1000;
  const url = `${opts.host.replace(/\/$/, "")}/multi-search`;
  let offset = 0;
  let firstReported = false;
  for (;;) {
    const body = {
      queries: [{ indexUid: opts.indexUid, limit: batch, offset }],
    };
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.token}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(
        `meilisearch ${url} offset=${offset}: ${res.status} ${res.statusText}`,
      );
    }
    const json = (await res.json()) as {
      results: {
        hits: Record<string, unknown>[];
        estimatedTotalHits?: number;
        totalHits?: number;
      }[];
    };
    const result = json.results?.[0];
    const hits = result?.hits ?? [];
    if (!firstReported) {
      firstReported = true;
      const total =
        result?.totalHits ?? result?.estimatedTotalHits ?? null;
      opts.onFirstResponse?.({ estimatedTotalHits: total });
    }
    if (hits.length === 0) return;
    for (const hit of hits) {
      const out = opts.mapHit(hit);
      if (out !== null) yield out;
    }
    if (hits.length < batch) return;
    offset += batch;
  }
}
