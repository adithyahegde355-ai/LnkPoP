
const BASE = "https://api.mangadex.org";
const RATING = ["safe", "suggestive"] as const;
const ADULT_RATING = ["erotica", "pornographic"] as const;

export type Manga = {
  id: string;
  title: string;
  cover: string;
  status: string;
  desc: string;
  year: number | null;
  lang: string;
  adult?: boolean;
  hasEnglishTitle?: boolean;
};

export type Chapter = {
  id: string;
  num: string;
  title: string;
  pages: number;
  date: string;
};

type Params = Record<string, string | number | string[]>;

// Keep API failures readable in the app. MangaDex can return HTML (for example,
// an edge/proxy error page), so do not dump the entire response into the UI.
const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

let requestTail: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

async function paceRequests() {
  const waitForTurn = requestTail.then(async () => {
    const delay = Math.max(0, 250 - (Date.now() - lastRequestAt));
    if (delay) await sleep(delay);
    lastRequestAt = Date.now();
  });

  requestTail = waitForTurn.catch(() => {});
  await waitForTurn;
}

async function get(
  path: string,
  p: Params = {},
  retries = 2
): Promise<any> {
  const u = new URLSearchParams();

  for (const [k, v] of Object.entries(p)) {
    if (Array.isArray(v)) {
      v.forEach((x) => u.append(k, x));
    } else {
      u.append(k, String(v));
    }
  }

  const url = `${BASE}${path}?${u.toString()}`;

  for (let attempt = 0; ; attempt++) {
    await paceRequests();

    let response: Response;

    try {
      response = await fetch(url, {
        headers: { Accept: "application/json" },
      });
    } catch {
      if (attempt < retries) {
        await sleep(500 * (attempt + 1));
        continue;
      }

      throw new Error(
        "Could not connect to MangaDex. Check your internet connection and try again."
      );
    }

    if (
      (response.status === 429 || response.status >= 500) &&
      attempt < retries
    ) {
      const retryAfter = Number(response.headers.get("Retry-After"));

      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 800 * (attempt + 1)
      );

      continue;
    }

    if (!response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      const body = await response.text().catch(() => "");

      let detail = "";

      if (contentType.includes("json")) {
        try {
          const parsed = JSON.parse(body);

          detail = Array.isArray(parsed.errors)
            ? parsed.errors
                .map((item: any) => item.detail ?? item.title)
                .filter(Boolean)
                .join("; ")
            : parsed.message ?? "";
        } catch {
          // Keep the generic status message.
        }
      } else if (body && !/<html|<!doctype/i.test(body)) {
        detail = body.slice(0, 160).replace(/\s+/g, " ");
      } else if (body) {
        detail =
          "The server returned an HTML page instead of API JSON";
      }

      throw new Error(
        `MangaDex request failed (HTTP ${response.status})` +
          (detail ? `: ${detail}` : "") +
          "."
      );
    }

    try {
      return await response.json();
    } catch {
      throw new Error(
        "MangaDex returned an invalid response. Please try again."
      );
    }
  }
}

function toManga(m: any): Manga {
  const a = m.attributes;

  const file = m.relationships?.find(
    (r: any) => r.type === "cover_art"
  )?.attributes?.fileName;

  // Prefer the official English title. If the main title is not English,
  // MangaDex may provide an English alternative title in altTitles.
  const englishAlternative = (a.altTitles ?? [])
    .map((entry: Record<string, string>) => entry.en)
    .find((value: string | undefined) => Boolean(value?.trim()));

  const englishTitle = a.title?.en ?? englishAlternative;

  const fallbackTitle = (
    Object.values(a.title ?? {}) as string[]
  ).find(Boolean);

  return {
    id: m.id,
    title:
      englishTitle ??
      fallbackTitle ??
      "English title unavailable",

    // Small poster thumbnail served by MangaDex.
    cover: file
      ? `https://uploads.mangadex.org/covers/${m.id}/${file}.256.jpg`
      : "",

    status: a.status ?? "",
    desc: a.description?.en ?? "",
    year: a.year ?? null,
    lang: a.originalLanguage ?? "",
    hasEnglishTitle: Boolean(englishTitle?.trim()),
  };
}

export async function listManga(o: {
  q?: string;
  lang?: string;
  sort?: "popular" | "latest";
  offset?: number;
  limit?: number;
  adultOnly?: boolean;
}) {
  const p: Params = {
    limit: o.limit ?? 30,
    offset: o.offset ?? 0,
    "includes[]": ["cover_art"],
    "contentRating[]": o.adultOnly
      ? [...ADULT_RATING]
      : [...RATING],
    "availableTranslatedLanguage[]": ["en"],
  };

  if (o.q) p.title = o.q;
  if (o.lang) p["originalLanguage[]"] = [o.lang];

  p[
    o.sort === "latest"
      ? "order[latestUploadedChapter]"
      : "order[followedCount]"
  ] = "desc";

  const j = await get("/manga", p);

  let items = (j.data as any[]).map((entry: any) => ({
    ...toManga(entry),
    adult: Boolean(o.adultOnly),
  }));

  // Adult shelves require an English display title.
  if (o.adultOnly) {
    items = items
      .filter((m) => m.hasEnglishTitle)
      .slice(0, o.limit ?? 30);
  }

  return {
    items,
    total: j.total as number,
  };
}

// Fetch MangaDex result pages for an adult category.
// Avoid unbounded pagination if the source changes during the search.
export async function listAllAdultManga(
  lang: string
): Promise<Manga[]> {
  const collected: Manga[] = [];
  const seen = new Set<string>();

  const pageSize = 100;
  const maxResults = 5000;

  let offset = 0;
  let total = Number.POSITIVE_INFINITY;

  while (offset < total && offset < maxResults) {
    const result = await listManga({
      lang,
      limit: pageSize,
      offset,
      adultOnly: true,
    });

    for (const item of result.items) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        collected.push(item);
      }
    }

    total = result.total;

    if (
      result.items.length === 0 ||
      result.total <= offset + pageSize
    ) {
      break;
    }

    offset += pageSize;
  }

  return collected;
}

// Prefer English chapters. If none are available, fall back to
// other languages for regular titles.
export async function getFeed(
  id: string,
  englishOnly = false
): Promise<Chapter[]> {
  const fetchFeed = async (
    englishOnly: boolean
  ): Promise<Chapter[]> => {
    const out = new Map<string, Chapter>();

    for (
      let offset = 0;
      offset < 2000;
      offset += 500
    ) {
      const params: Params = {
        limit: 500,
        offset,
        "order[chapter]": "desc",
        includeExternalUrl: 0,
      };

      if (englishOnly) {
        params["translatedLanguage[]"] = ["en"];
      }

      const j = await get(`/manga/${id}/feed`, params);

      for (const c of j.data as any[]) {
        const a = c.attributes;

        if (!a.pages) continue;

        const num = a.chapter ?? "Oneshot";

        if (!out.has(num)) {
          out.set(num, {
            id: c.id,
            num,
            title: a.title ?? "",
            pages: a.pages,
            date: a.publishAt ?? "",
          });
        }
      }

      if (offset + 500 >= j.total) break;
    }

    return [...out.values()];
  };

  if (englishOnly) {
    return fetchFeed(true);
  }

  const english = await fetchFeed(true);

  return english.length
    ? english
    : fetchFeed(false);
}

export async function getPages(
  chapterId: string,
  saver: boolean
): Promise<string[]> {
  const j = await get(
    `/at-home/server/${chapterId}`
  );

  const files: string[] = saver
    ? j.chapter.dataSaver
    : j.chapter.data;

  const quality = saver ? "data-saver" : "data";

  return files.map(
    (f: string) =>
      `${j.baseUrl}/${quality}/${j.chapter.hash}/${f}`
  );
}
