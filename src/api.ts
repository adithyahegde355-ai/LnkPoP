const BASE = "https://api.mangadex.org";
const RATING = ["safe", "suggestive"];

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

export type Chapter = { id: string; num: string; title: string; pages: number; date: string };

type Params = Record<string, string | number | string[]>;

async function get(path: string, p: Params = {}) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) {
    if (Array.isArray(v)) v.forEach((x) => u.append(k, x));
    else u.append(k, String(v));
  }
  const r = await fetch(`${BASE}${path}?${u}`);
  if (!r.ok) throw new Error(`MangaDex error ${r.status}`);
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
    "contentRating[]": o.adultOnly ? ["erotica", "pornographic"] : RATING,
    "availableTranslatedLanguage[]": ["en"],
    hasAvailableChapters: "true",
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
export async function getFeed(id: string, englishOnly = false): Promise<Chapter[]> {
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

export async function getPages(chapterId: string, saver: boolean): Promise<string[]> {
  const j = await get(`/at-home/server/${chapterId}`);
  const files: string[] = saver ? j.chapter.dataSaver : j.chapter.data;
  const q = saver ? "data-saver" : "data";
  return files.map((f) => `${j.baseUrl}/${q}/${j.chapter.hash}/${f}`);
}
