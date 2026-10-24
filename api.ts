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
  links: Record<string, string>;
};

// ext = link to the official site when MangaDex does not host the pages
export type Chapter = { id: string; num: string; title: string; pages: number; date: string; lang: string; ext: string };
export type Tag = { id: string; name: string };

type Params = Record<string, string | number | string[]>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(path: string, p: Params = {}, retry = 2): Promise<any> {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) {
    if (Array.isArray(v)) v.forEach((x) => u.append(k, x));
    else u.append(k, String(v));
  }
  const r = await fetch(`${BASE}${path}?${u}`);
  // MangaDex allows ~5 requests/second: wait and retry when throttled
  if (r.status === 429 && retry > 0) {
    await sleep(1200);
    return get(path, p, retry - 1);
  }
  if (!r.ok) throw new Error(`MangaDex error ${r.status}`);
  return r.json();
}

function toManga(m: any): Manga {
  const a = m.attributes;
  const file = m.relationships?.find((r: any) => r.type === "cover_art")?.attributes?.fileName;
  return {
    id: m.id,
    title: a.title?.en ?? (Object.values(a.title ?? {})[0] as string) ?? "Untitled",
    cover: file ? `https://uploads.mangadex.org/covers/${m.id}/${file}.512.jpg` : "",
    status: a.status ?? "",
    desc: a.description?.en ?? "",
    year: a.year ?? null,
    lang: a.originalLanguage ?? "",
    links: a.links ?? {},
  };
}

let tagCache: Tag[] | null = null;
export async function getGenres(): Promise<Tag[]> {
  if (tagCache) return tagCache;
  const j = await get("/manga/tag");
  tagCache = (j.data as any[])
    .filter((t) => t.attributes.group === "genre")
    .map((t) => ({ id: t.id as string, name: t.attributes.name.en as string }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return tagCache;
}

export async function listManga(o: {
  q?: string;
  lang?: string;
  tag?: string;
  sort?: "popular" | "latest";
  offset?: number;
  limit?: number;
}) {
  const p: Params = {
    limit: o.limit ?? 24,
    offset: o.offset ?? 0,
    "includes[]": ["cover_art"],
    "contentRating[]": RATING,
    "availableTranslatedLanguage[]": ["en"],
    hasAvailableChapters: "true",
  };
  if (o.q) p.title = o.q;
  if (o.lang) p["originalLanguage[]"] = [o.lang];
  if (o.tag) p["includedTags[]"] = [o.tag];
  p[o.sort === "latest" ? "order[latestUploadedChapter]" : "order[followedCount]"] = "desc";
  const j = await get("/manga", p);
  return { items: (j.data as any[]).map(toManga), total: j.total as number };
}

async function fetchFeed(id: string, langs?: string[]): Promise<any[]> {
  const all: any[] = [];
  for (let offset = 0; offset < 15000; offset += 500) {
    const p: Params = { limit: 500, offset, "order[chapter]": "desc" };
    if (langs) p["translatedLanguage[]"] = langs;
    const j = await get(`/manga/${id}/feed`, p);
    all.push(...j.data);
    if (offset + 500 >= j.total) break;
  }
  return all;
}

const usable = (c: any) => c.attributes.pages > 0 || !!c.attributes.externalUrl;

// All chapters, newest first, one entry per chapter number.
// Prefers pages hosted on MangaDex, then English. Falls back to other languages if English has nothing readable.
export async function getFeed(id: string): Promise<Chapter[]> {
  let raw = await fetchFeed(id, ["en"]);
  if (!raw.some((c) => usable(c) && !c.attributes.externalUrl)) {
    raw = [...raw, ...(await fetchFeed(id))];
  }
  const score = (c: Chapter) => (c.ext ? 0 : 2) + (c.lang === "en" ? 1 : 0);
  const out = new Map<string, Chapter>();
  for (const c of raw) {
    if (!usable(c)) continue;
    const a = c.attributes;
    const ch: Chapter = {
      id: c.id,
      num: a.chapter ?? "Oneshot",
      title: a.title ?? "",
      pages: a.pages ?? 0,
      date: a.publishAt ?? "",
      lang: a.translatedLanguage ?? "en",
      ext: a.externalUrl ?? "",
    };
    const old = out.get(ch.num);
    if (!old || score(ch) > score(old)) out.set(ch.num, ch);
  }
  return [...out.values()];
}

export async function getPages(chapterId: string, saver: boolean): Promise<string[]> {
  const j = await get(`/at-home/server/${chapterId}`);
  const files: string[] = saver ? j.chapter.dataSaver : j.chapter.data;
  const q = saver ? "data-saver" : "data";
  return files.map((f) => `${j.baseUrl}/${q}/${j.chapter.hash}/${f}`);
}
