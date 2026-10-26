
import { useCallback, useEffect, useRef, useState } from "react";
import { App as CapApp } from "@capacitor/app";
import {
  Chapter,
  Manga,
  getFeed,
  getPages,
  listAllAdultManga,
  listManga,
} from "./api";

type Tab = "home" | "browse" | "library";

const LANG_LABEL: Record<string, string> = {
  ko: "Manhwa",
  ja: "Manga",
  zh: "Manhua",
};

const store = {
  get<T>(k: string, d: T): T {
    try {
      return JSON.parse(localStorage.getItem(k) ?? "") as T;
    } catch {
      return d;
    }
  },
  set(k: string, v: unknown) {
    localStorage.setItem(k, JSON.stringify(v));
  },
};

function Poster({
  m,
  open,
}: {
  m: Manga;
  open: (m: Manga) => void;
}) {
  return (
    <button className="poster" onClick={() => open(m)}>
      <div className="img">
        {m.cover && (
          <img src={m.cover} loading="lazy" alt="" />
        )}
        <span className={`tag ${m.lang}`}>
          {LANG_LABEL[m.lang] ?? "Manga"}
        </span>
      </div>
      <p>{m.title}</p>
    </button>
  );
}

function Home({ open }: { open: (m: Manga) => void }) {
  const [rows, setRows] = useState<[string, Manga[]][]>([]);
  const [adultRows, setAdultRows] = useState<[string, Manga[]][]>([]);
  const [adultUnlocked, setAdultUnlocked] = useState(false);
  const [adultBusy, setAdultBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let cancelled = false;

    const shelves: Array<
      [string, { lang?: string; sort?: "popular" | "latest" }]
    > = [
      ["🔥 Popular manhwa", { lang: "ko" }],
      ["⚡ Popular manga", { lang: "ja" }],
      ["🐉 Popular manhua", { lang: "zh" }],
      ["🆕 Just updated", { sort: "latest" }],
    ];

    (async () => {
      const failures: string[] = [];

      for (const [title, options] of shelves) {
        try {
          const result = await listManga({
            ...options,
            limit: 15,
          });

          if (!cancelled && result.items.length) {
            setRows((current) => [
              ...current.filter(([existing]) => existing !== title),
              [title, result.items],
            ]);
          }
        } catch (error: any) {
          failures.push(
            `${title}: ${error?.message ?? "request failed"}`
          );
        }
      }

      if (!cancelled && failures.length) {
        setErr(
          failures.length === shelves.length
            ? `Could not load MangaDex shelves. ${failures[0]}`
            : `Some shelves could not load: ${failures.join(" · ")}`
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const loadAdult = async () => {
    if (adultUnlocked || adultBusy) return;

    setAdultBusy(true);

    try {
      const results = await Promise.allSettled([
        listAllAdultManga("ko"),
        listAllAdultManga("ja"),
        listAllAdultManga("zh"),
      ]);

      const labels = [
        "🔞 H-Manhwa · English titles & chapters",
        "🔞 Hentai Manga · English titles & chapters",
        "🔞 H-Manhua · English titles & chapters",
      ];

      const nextRows: [string, Manga[]][] = [];
      const failures: string[] = [];

      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          nextRows.push([labels[index], result.value]);
        } else {
          failures.push(
            `${labels[index]}: ${result.reason?.message ?? "request failed"}`
          );
        }
      });

      setAdultRows(nextRows);
      setAdultUnlocked(nextRows.length > 0);

      if (failures.length) {
        setErr(
          `Some adult shelves could not load: ${failures.join(" · ")}`
        );
      }

      if (!nextRows.length) {
        setErr(
          failures.join(" · ") ||
            "No adult titles could be loaded."
        );
      }
    } finally {
      setAdultBusy(false);
    }
  };

  if (!rows.length && !err) {
    return <p className="note">Loading MangaDex titles…</p>;
  }

  return (
    <>
      {err && <p className="note">{err}</p>}

      {rows.map(([title, items]) => (
        <section key={title}>
          <h2>{title}</h2>
          <div className="row">
            {items.map((m) => (
              <Poster key={m.id} m={m} open={open} />
            ))}
          </div>
        </section>
      ))}

      <section className="adult-section">
        <h2>🔞 18+ Hentai Manga, H-Manhwa &amp; H-Manhua</h2>

        {!adultUnlocked ? (
          <div className="adult-gate">
            <p>
              Adults only (18+). This section contains
              mature/sexually explicit fictional comics. By
              continuing, you confirm you are 18 or older and
              that viewing this content is legal where you live.
              The app searches matching titles across result
              pages (up to 5,000 results per language to keep
              requests bounded). Only titles with an English
              display title and free English chapters are shown;
              availability depends on the source.
            </p>

            <button
              className="primary"
              onClick={loadAdult}
              disabled={adultBusy}
            >
              {adultBusy
                ? "Finding English chapters…"
                : "I am 18+ · Show adult titles"}
            </button>
          </div>
        ) : (
          adultRows.map(([title, items]) => (
            <section key={title}>
              <h3>{title}</h3>

              {items.length ? (
                <div className="row">
                  {items.map((m) => (
                    <Poster key={m.id} m={m} open={open} />
                  ))}
                </div>
              ) : (
                <p className="note">
                  No titles matching English-title and
                  free-English-chapter filters were returned
                  right now. The source catalogue may not
                  currently have matches.
                </p>
              )}
            </section>
          ))
        )}
      </section>
    </>
  );
}

function Browse({ open }: { open: (m: Manga) => void }) {
  const [q, setQ] = useState("");
  const [lang, setLang] = useState("");
  const [items, setItems] = useState<Manga[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(
    async (offset: number) => {
      setBusy(true);
      setErr("");

      try {
        const r = await listManga({
          q: q.trim() || undefined,
          lang: lang || undefined,
          offset,
        });

        setItems((p) => (offset ? [...p, ...r.items] : r.items));
        setTotal(r.total);
      } catch (e: any) {
        setErr(e.message);
      } finally {
        setBusy(false);
      }
    },
    [q, lang]
  );

  useEffect(() => {
    const t = setTimeout(() => load(0), 400);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <>
      <input
        className="search"
        placeholder="Search manga, manhwa & manhua…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />

      <div className="chips">
        {[
          ["All", ""],
          ["Manhwa", "ko"],
          ["Manga", "ja"],
          ["Manhua", "zh"],
        ].map(([label, v]) => (
          <button
            key={label}
            className={lang === v ? "chip on" : "chip"}
            onClick={() => setLang(v)}
          >
            {label}
          </button>
        ))}
      </div>

      {err && <p className="note">{err}</p>}

      <div className="grid">
        {items.map((m) => (
          <Poster key={m.id} m={m} open={open} />
        ))}
      </div>

      {busy && <p className="note">Loading…</p>}

      {!busy && items.length < total && (
        <button className="more" onClick={() => load(items.length)}>
          Load more
        </button>
      )}
    </>
  );
}

function Detail(props: {
  m: Manga;
  fav: boolean;
  toggleFav: () => void;
  read: string[];
  openChapter: (list: Chapter[], i: number) => void;
}) {
  const { m, fav, toggleFav, read, openChapter } = props;
  const [chs, setChs] = useState<Chapter[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    getFeed(m.id, Boolean(m.adult))
      .then(setChs)
      .catch((e) => setErr(e.message));
  }, [m.id, m.adult]);

  return (
    <div className="page">
      <div className="hero">
        {m.cover && <img src={m.cover} alt="" />}

        <div>
          <h1>{m.title}</h1>

          <p className="meta">
            {LANG_LABEL[m.lang] ?? "Manga"} · {m.status}
            {m.year ? ` · ${m.year}` : ""}
          </p>

          <div className="actions">
            <button
              className="primary"
              disabled={!chs?.length}
              onClick={() =>
                chs && openChapter(chs, chs.length - 1)
              }
            >
              ▶ Start
            </button>

            <button
              className={fav ? "ghost on" : "ghost"}
              onClick={toggleFav}
            >
              {fav ? "♥ Saved" : "♡ Save"}
            </button>
          </div>
        </div>
      </div>

      {m.desc && <p className="desc">{m.desc}</p>}

      <h2>Chapters {chs ? `(${chs.length})` : ""}</h2>

      {err && <p className="note">{err}</p>}

      {!chs && !err && (
        <p className="note">Loading chapters…</p>
      )}

      {chs?.length === 0 && (
        <p className="note">
          No readable free chapters are listed for this title
          on MangaDex yet. Try another title or check back later.
        </p>
      )}

      <ul className="chapters">
        {chs?.map((c, i) => (
          <li key={c.id}>
            <button
              className={read.includes(c.id) ? "ch done" : "ch"}
              onClick={() => openChapter(chs, i)}
            >
              <b>
                {c.num === "Oneshot" ? "Oneshot" : `Ch. ${c.num}`}
              </b>
              <span>{c.title}</span>
              <small>{c.date.slice(0, 10)}</small>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Reader(props: {
  list: Chapter[];
  idx: number;
  setIdx: (i: number) => void;
  title: string;
}) {
  const { list, idx, setIdx, title } = props;
  const ch = list[idx];

  const [saver, setSaver] = useState<boolean>(
    store.get("saver", false)
  );
  const [pages, setPages] = useState<string[] | null>(null);
  const [err, setErr] = useState("");
  const [tries, setTries] = useState(0);

  const failed = useRef(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    failed.current = false;
    setPages(null);
    setErr("");

    getPages(ch.id, saver)
      .then(setPages)
      .catch((e) => setErr(e.message));

    box.current?.scrollTo(0, 0);
  }, [ch.id, saver, tries]);

  const onImgError = () => {
    if (!failed.current && tries < 2) {
      failed.current = true;
      setTries((t) => t + 1);
    }
  };

  return (
    <div className="reader" ref={box}>
      <div className="rbar">
        <span>
          {title} ·{" "}
          {ch.num === "Oneshot" ? "Oneshot" : `Ch. ${ch.num}`}
        </span>

        <button
          onClick={() => {
            store.set("saver", !saver);
            setSaver(!saver);
          }}
        >
          {saver ? "Data saver ON" : "Data saver OFF"}
        </button>
      </div>

      {err && <p className="note light">{err}</p>}

      {!pages && !err && (
        <p className="note light">Loading pages…</p>
      )}

      {pages?.map((src) => (
        <img
          key={src}
          src={src}
          className="page-img"
          loading="lazy"
          alt=""
          onError={onImgError}
        />
      ))}

      {pages && (
        <div className="rnav">
          <button
            disabled={idx >= list.length - 1}
            onClick={() => setIdx(idx + 1)}
          >
            ◀ Previous
          </button>

          <button
            disabled={idx <= 0}
            onClick={() => setIdx(idx - 1)}
          >
            Next ▶
          </button>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>("home");
  const [manga, setManga] = useState<Manga | null>(null);

  const [reading, setReading] = useState<{
    list: Chapter[];
    idx: number;
  } | null>(null);

  const [lib, setLib] = useState<Manga[]>(
    store.get("lib", [])
  );

  const [read, setRead] = useState<string[]>(
    store.get("read", [])
  );

  useEffect(() => {
    const h = CapApp.addListener("backButton", () => {
      if (reading) setReading(null);
      else if (manga) setManga(null);
      else if (tab !== "home") setTab("home");
      else CapApp.exitApp();
    });

    return () => {
      h.then((x) => x.remove());
    };
  }, [reading, manga, tab]);

  const toggleFav = (m: Manga) => {
    const next = lib.some((x) => x.id === m.id)
      ? lib.filter((x) => x.id !== m.id)
      : [m, ...lib];

    setLib(next);
    store.set("lib", next);
  };

  const markRead = (id: string) => {
    if (read.includes(id)) return;

    const next = [...read, id];
    setRead(next);
    store.set("read", next);
  };

  const openChapter = (list: Chapter[], idx: number) => {
    markRead(list[idx].id);
    setReading({ list, idx });
  };

  const setIdx = (idx: number) => {
    if (!reading) return;

    markRead(reading.list[idx].id);
    setReading({ ...reading, idx });
  };

  return (
    <div className="shell">
      <header>
        <span className="logo">
          Ink<b>pop</b>
        </span>
      </header>

      <main>
        {tab === "home" && <Home open={setManga} />}
        {tab === "browse" && <Browse open={setManga} />}

        {tab === "library" &&
          (lib.length ? (
            <div className="grid">
              {lib.map((m) => (
                <Poster key={m.id} m={m} open={setManga} />
              ))}
            </div>
          ) : (
            <p className="note">
              Nothing saved yet. Open a title and tap Save.
            </p>
          ))}
      </main>

      <nav>
        {(["home", "browse", "library"] as Tab[]).map((t) => (
          <button
            key={t}
            className={tab === t ? "on" : ""}
            onClick={() => setTab(t)}
          >
            {t === "home"
              ? "🏠 Home"
              : t === "browse"
                ? "🔎 Browse"
                : "💖 Library"}
          </button>
        ))}
      </nav>

      {manga && (
        <Detail
          m={manga}
          fav={lib.some((x) => x.id === manga.id)}
          toggleFav={() => toggleFav(manga)}
          read={read}
          openChapter={openChapter}
        />
      )}

      {reading && manga && (
        <Reader
          list={reading.list}
          idx={reading.idx}
          setIdx={setIdx}
          title={manga.title}
        />
      )}
    </div>
  );
}
