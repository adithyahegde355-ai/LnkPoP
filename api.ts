const BASE = "https://api.mangadex.org";
const MANGAPDF_BASES = ["https://api.coffeemanga.shop", "https://api.mangapdf.org"];
export type MangaSource = "mangadex" | "mangapdf";
const RATING = ["safe", "suggestive"] as const;
const ADULT_RATING = ["suggestive", "erotica", "pornographic"] as const;

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
  source?: MangaSource;
};

export type Chapter = { id: string; num: string; title: string; pages: number; date: string; source?: MangaSource };

type Params = Record<string, string | number | string[]>;

async function get(path: string, p: Params = {}) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) {
    if (Array.isArray(v)) v.forEach((x) => u.append(k, x));
    else u.append(k, String(v));
  }
  const r = await fetch(`${BASE}${path}?${u}`);
  if (!r.ok) {
    // Keep the server response detail visible for diagnosis instead of hiding
    // the reason behind a generic HTTP error.
    const detail = await r.text().catch(() => "");
    throw new Error(`MangaDex error ${r.status}${detail ? `: ${detail.slice(0, 240)}` : ""}`);
  }
  return r.json();
}

function toManga(m: any): Manga {
  const a = m.attributes;
  const file = m.relationships?.find((r: any) => r.type === "cover_art")?.attributes?.fileName;
  // Prefer the official English title. If the main title is not English,
  // MangaDex may provide an English alternative title in altTitles.
  const englishAlternative = (a.altTitles ?? [])
    .map((entry: Record<string, string>) => entry.en)
    .find((value: string | undefined) => Boolean(value?.trim()));
  const englishTitle = a.title?.en ?? englishAlternative;
  const fallbackTitle = (Object.values(a.title ?? {}) as string[]).find(Boolean);
  return {
    id: m.id,
    title: englishTitle ?? fallbackTitle ?? "English title unavailable",
    // .256.jpg = small poster thumbnail served by MangaDex
    cover: file ? `https://uploads.mangadex.org/covers/${m.id}/${file}.256.jpg` : "",
    status: a.status ?? "",
    desc: a.description?.en ?? "",
    year: a.year ?? null,
    lang: a.originalLanguage ?? "",
    hasEnglishTitle: Boolean(englishTitle?.trim()),
    source: "mangadex",
  };
}


// MangaPDF public read-only API. Its documented API requires the X-Client header.
// MangaPDF IDs are namespaced in this app to avoid collisions with MangaDex IDs.
async function getMangaPDF<T>(path: string): Promise<T> {
  let lastError: Error | null = null;
  for (const base of MANGAPDF_BASES) {
    try {
      const response = await fetch(`${base}${path}`, {
        headers: { Accept: "application/json", "X-Client": "api-consumer" },
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        lastError = new Error(`MangaPDF error ${response.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`);
        // Try the documented alternate host on server or host errors.
        if (response.status >= 500 || response.status === 404) continue;
        throw lastError;
      }
      return await response.json() as T;
    } catch (error: any) {
      lastError = error instanceof Error ? error : new Error("MangaPDF request failed");
    }
  }
  throw lastError ?? new Error("MangaPDF is unavailable. Please try again later.");
}

type MangaPDFListResponse = {
  items?: Array<{ id: string; title?: string; thumbnail_url?: string }>;
  has_next?: boolean;
};

export async function listMangaPDF(options: {
  q?: string;
  sort?: "popular" | "latest";
  page?: number;
} = {}): Promise<{ items: Manga[]; hasNext: boolean }> {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const query = options.q?.trim();
  const path = query
    ? `/api/v1/mihon/search?q=${encodeURIComponent(query.slice(0, 200))}&page=${page}`
    : `/api/v1/mihon/${options.sort === "latest" ? "latest" : "popular"}?page=${page}`;
  const payload = await getMangaPDF<MangaPDFListResponse>(path);
  return {
    items: (payload.items ?? []).map((item) => ({
      id: `mp:${item.id}`,
      title: item.title?.trim() || "Untitled",
      cover: item.thumbnail_url || "",
      status: "",
      desc: "",
      year: null,
      lang: "",
      source: "mangapdf",
      hasEnglishTitle: Boolean(item.title?.trim()),
    })),
    hasNext: Boolean(payload.has_next),
  };
}

async function getMangaPDFDetails(id: string): Promise<any> {
  return getMangaPDF<any>(`/api/v1/mihon/manga/${encodeURIComponent(id.replace(/^mp:/, ""))}`);
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
    "contentRating[]": o.adultOnly ? [...ADULT_RATING] : [...RATING],
    "availableTranslatedLanguage[]": ["en"],
  };
  if (o.q) p.title = o.q;
  if (o.lang) p["originalLanguage[]"] = [o.lang];
  p[o.sort === "latest" ? "order[latestUploadedChapter]" : "order[followedCount]"] = "desc";
  const j = await get("/manga", p);
  let items = (j.data as any[]).map((entry: any) => ({ ...toManga(entry), adult: Boolean(o.adultOnly) }));
  // Adult shelves must show English display titles, not silently fall back to
  // Japanese/Korean/Chinese names. The API filters for free English releases.
  if (o.adultOnly) items = items.filter((m) => m.hasEnglishTitle).slice(0, o.limit ?? 30);
  return { items, total: j.total as number };
}


// Fetch every MangaDex result page for a category, keeping only titles with an
// English display title. MangaDex remains the live source of truth; this does
// not fabricate titles or chapter listings.
export async function listAllAdultManga(lang: string): Promise<Manga[]> {
  const collected: Manga[] = [];
  const pageSize = 100;
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  while (offset < total) {
    const result = await listManga({ lang, limit: pageSize, offset, adultOnly: true });
    collected.push(...result.items);
    total = result.total;
    if (result.items.length === 0 && offset >= total) break;
    offset += pageSize;
  }
  return collected;
}

// Prefer English chapters. If none are available, fall back to free chapters
// published in other languages so titles with non-English releases can still open.
export async function getFeed(
  id: string,
  englishOnly = false,
  source: MangaSource = "mangadex"
): Promise<Chapter[]> {
  if (source === "mangapdf") {
    const payload = await getMangaPDFDetails(id);
    return (payload.chapters ?? []).map((chapter: any): Chapter => ({
      id: `mp:${String(chapter.id)}`,
      num: chapter.number == null ? "Oneshot" : String(chapter.number),
      title: chapter.name ?? "",
      // MangaPDF's documented detail response does not include page counts.
      pages: 0,
      date: chapter.uploaded_at ?? "",
      source: "mangapdf",
    }));
  }
  const fetchFeed = async (englishOnly: boolean) => {
    const out = new Map<string, Chapter>();
    for (let offset = 0; offset < 2000; offset += 500) {
      const params: Params = {
        limit: 500,
        offset,
        "order[chapter]": "desc",
        includeExternalUrl: 0,
      };
      if (englishOnly) params["translatedLanguage[]"] = ["en"];
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
            source: "mangadex",
          });
        }
      }
      if (offset + 500 >= j.total) break;
    }
    return [...out.values()];
  };
  if (englishOnly) return fetchFeed(true);
  const english = await fetchFeed(true);
  return english.length ? english : fetchFeed(false);
}

export async function getPages(
  chapterId: string,
  saver: boolean,
  source: MangaSource = "mangadex"
): Promise<string[]> {
  if (source === "mangapdf") {
    const payload = await getMangaPDF<{ pages?: Array<{ index: number; image_url: string }> }>(
      `/api/v1/mihon/chapter/${encodeURIComponent(chapterId.replace(/^mp:/, ""))}/pages`
    );
    return (payload.pages ?? [])
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((page) => page.image_url)
      .filter((url) => /^https:\/\//i.test(url));
  }
  const j = await get(`/at-home/server/${chapterId}`);
  const files: string[] = saver ? j.chapter.dataSaver : j.chapter.data;
  const q = saver ? "data-saver" : "data";
  return files.map((f) => `${j.baseUrl}/${q}/${j.chapter.hash}/${f}`);
}
