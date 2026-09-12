"""Dev server for the appkittie clone (v2).

Serves index.html + proxies Apple endpoints server-side (Apple sends no
CORS headers, so browsers block direct fetch) + SQLite library backing
the ~15k-app build, whole-store live search, and YouTube ad/viral tracking.

Stdlib only. Run:  python server.py  -> http://localhost:8001
(or set PORT env var). Double-click start.bat on the Desktop folder.
"""
import concurrent.futures as cf
import html as ihtml
import json
import os
import re
import sqlite3
import threading
import time
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

ITUNES = "https://itunes.apple.com"
BASE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(BASE, "data", "appkitty.db")

COUNTRIES = ["us", "gb", "ca", "au"]
KINDS = ["topgrossingapplications", "topfreeapplications", "toppaidapplications"]
# '' = overall chart; rest are iOS genre ids.
GENRES = ["", "6014", "6016", "6008", "6005", "6007", "6015",
          "6012", "6013", "6011", "6017", "6000", "6004"]

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9"}

BUILD = {"running": False, "phase": "idle", "done": 0, "total": 0, "apps": 0, "error": ""}
BUILD_LOCK = threading.Lock()


# ---------------- db ----------------
def db():
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    c = sqlite3.connect(DB, timeout=30)
    c.row_factory = sqlite3.Row
    c.execute("""CREATE TABLE IF NOT EXISTS apps(
      id TEXT PRIMARY KEY, title TEXT, dev TEXT, icon TEXT, cat TEXT,
      price REAL, rating REAL, rc INTEGER, ver TEXT, rel TEXT, descc TEXT,
      shots TEXT, url TEXT, bundle TEXT, tier INTEGER, rank INTEGER,
      genre TEXT, country TEXT, rev INTEGER, dl INTEGER, growth REAL,
      updated TEXT)""")
    c.execute("""CREATE TABLE IF NOT EXISTS snaps(
      app_id TEXT, date TEXT, rev INTEGER, dl INTEGER, rc INTEGER,
      rank INTEGER, PRIMARY KEY(app_id, date))""")
    c.execute("CREATE TABLE IF NOT EXISTS yt(qid TEXT PRIMARY KEY, fetched INTEGER, videos TEXT)")
    c.execute("CREATE TABLE IF NOT EXISTS watch(app_id TEXT PRIMARY KEY, added TEXT)")
    return c


def today():
    return time.strftime("%Y-%m-%d")


# ---------------- estimation (mirrors app.js) ----------------
CATMULT = {"Games": 1.3, "Game": 1.3, "Entertainment": 1.2, "Photo & Video": 1.1,
           "Social Networking": 1.1, "Health & Fitness": 1.0, "Productivity": 0.9,
           "Finance": 1.15, "Music": 1.0, "Education": 0.8}


def cat_m(cat):
    for k, v in CATMULT.items():
        if k in (cat or ""):
            return v
    return 1.0


def estimate(rank, rc, cat, tier):
    import math
    vol = min(1.5, max(0.5, math.log10((rc or 100) + 10) / 6))
    rev = round(12000000 * (0.975 ** (rank - 1)) * vol * cat_m(cat))
    dl = round(15000000 * (0.972 ** (rank - 1)) * vol)
    if tier == 2:
        rev = round(rev * 0.5)
        dl = round(dl * 0.6)
    elif tier == 3:
        rev = round(rev * 0.35)
        dl = round(dl * 0.5)
    elif tier >= 4:
        rev = round(rev * 0.15)
        dl = round(dl * 0.8)
    return rev, dl


# ---------------- http helpers ----------------
def proxy(url, timeout=30):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def get_json(url):
    return json.loads(proxy(url).decode("utf-8", "ignore"))


def rss_ids(country, kind, genre, limit=200):
    url = f"{ITUNES}/{country}/rss/{kind}/limit={limit}"
    if genre:
        url += f"/genre={genre}"
    url += "/json"
    j = get_json(url)
    out = []
    for e in (j.get("feed", {}).get("entry") or []):
        try:
            out.append(e["id"]["attributes"]["im:id"])
        except KeyError:
            pass
    return out


def lookup_batch(ids):
    j = get_json(f"{ITUNES}/lookup?id={urllib.parse.quote(','.join(ids))}&country=us")
    return j.get("results", [])


# ---------------- build job (~15k library) ----------------
def upsert_app(c, r, tier, rank, genre, country):
    aid = str(r.get("trackId"))
    rc = r.get("userRatingCount") or 0
    cat = r.get("primaryGenreName") or ""
    rev, dl = estimate(rank, rc, cat, tier)
    shots = json.dumps((r.get("screenshotUrls") or [])[:6])
    desc = (r.get("description") or "")[:1500]
    # growth vs last snapshot
    grow = None
    row = c.execute("SELECT rev FROM snaps WHERE app_id=? ORDER BY date DESC LIMIT 1",
                    (aid,)).fetchone()
    if row and row["rev"]:
        grow = (rev - row["rev"]) / row["rev"]
    cur = c.execute("SELECT tier, rank FROM apps WHERE id=?", (aid,)).fetchone()
    if cur is None or tier < cur["tier"]:
        c.execute("""INSERT OR REPLACE INTO apps(id,title,dev,icon,cat,price,rating,rc,
          ver,rel,descc,shots,url,bundle,tier,rank,genre,country,rev,dl,growth,updated)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                  (aid, r.get("trackName"), r.get("artistName"), r.get("artworkUrl100"),
                   cat, r.get("price") or 0, r.get("averageUserRating") or 0, rc,
                   r.get("version"), r.get("releaseDate"), desc, shots,
                   r.get("trackViewUrl"), r.get("bundleId"), tier, rank, genre,
                   country, rev, dl, grow, today()))
    else:
        c.execute("UPDATE apps SET rating=?, rc=?, rev=?, dl=?, growth=?, updated=? WHERE id=?",
                  (r.get("averageUserRating") or 0, rc, rev, dl, grow, today(), aid))
    if not c.execute("SELECT 1 FROM snaps WHERE app_id=? AND date=?",
                     (aid, today())).fetchone():
        c.execute("INSERT INTO snaps(app_id,date,rev,dl,rc,rank) VALUES(?,?,?,?,?,?)",
                  (aid, today(), rev, dl, rc, rank))


def set_build(**kw):
    with BUILD_LOCK:
        BUILD.update(kw)


def build_job():
    set_build(running=True, phase="charts", done=0, total=0, apps=0, error="")
    try:
        jobs = [(co, k, g) for co in COUNTRIES for k in KINDS for g in GENRES]
        set_build(total=len(jobs))
        seen = {}  # id -> (tier, rank, genre, country)
        done = 0

        def one(job):
            co, kind, genre = job
            try:
                return job, rss_ids(co, kind, genre)
            except Exception:
                return job, []

        with cf.ThreadPoolExecutor(max_workers=12) as ex:
            for job, ids in ex.map(one, jobs):
                co, kind, genre = job
                for i, aid in enumerate(ids):
                    if kind == "topgrossingapplications" and co == "us" and not genre:
                        t = (1, i + 1)
                    elif kind == "topgrossingapplications" and co == "us":
                        t = (2, i + 1)
                    elif kind == "topgrossingapplications":
                        t = (3, i + 1)
                    else:
                        t = (4, i + 1)
                    if aid not in seen or t[0] < seen[aid][0]:
                        seen[aid] = (t[0], t[1], genre, co)
                done += 1
                set_build(done=done)

        ids = list(seen)
        set_build(phase="enrich", done=0, total=len(ids), apps=len(ids))
        c = db()
        n = 0
        for i in range(0, len(ids), 150):
            chunk = ids[i:i + 150]
            try:
                for r in lookup_batch(chunk):
                    tier, rank, genre, co = seen.get(str(r.get("trackId")), (4, 999, "", "us"))
                    upsert_app(c, r, tier, rank, genre, co)
                    n += 1
                c.commit()
            except Exception as e:
                print("lookup chunk failed:", e)
            set_build(done=min(i + 150, len(ids)))
            time.sleep(0.3)
        c.execute("VACUUM")
        c.close()
        set_build(phase="done", apps=n)
    except Exception as e:  # noqa: BLE001
        set_build(error=str(e)[:300], phase="error")
    finally:
        set_build(running=False)


def decode_yt(x):
    """Decode a YouTube-escaped title string without crashing."""
    if not x:
        return ""
    s = x.replace('\\"', '"').replace('\\/', '/')
    try:
        return json.loads('"' + s.replace('"', '\\"') + '"')
    except Exception:
        try:
            return ihtml.unescape(s)
        except Exception:
            return s


# ---------------- youtube (real, parseable) ----------------
def yt_search(query, limit=12):
    url = "https://www.youtube.com/results?search_query=" + urllib.parse.quote(query)
    html = proxy(url, timeout=20).decode("utf-8", "ignore")
    parts = html.split('"videoRenderer":')
    vids = []
    for p in parts[1:]:
        m = re.search(r'"videoId":"([A-Za-z0-9_-]{11})"', p)
        if not m:
            continue
        vid = m.group(1)
        tm = re.search(r'"title":\{"runs":\[\{"text":"(.*?)"', p)
        cm = re.search(r'longBylineText.*?"text":"(.*?)"', p)
        vm = re.search(r'viewCountText.*?"simpleText":"(.*?)"', p)
        pm = re.search(r'publishedTimeText.*?"simpleText":"(.*?)"', p)
        lm = re.search(r'"lengthText":\{"simpleText":"(.*?)"', p)
        vids.append({"id": vid, "title": decode_yt(tm.group(1)) if tm else "",
                     "channel": decode_yt(cm.group(1)) if cm else "",
                     "views": decode_yt(vm.group(1)) if vm else "",
                     "published": decode_yt(pm.group(1)) if pm else "",
                     "dur": decode_yt(lm.group(1)) if lm else ""})
        if len(vids) >= limit:
            break
    # de-dupe
    seen, out = set(), []
    for v in vids:
        if v["id"] not in seen:
            seen.add(v["id"])
            out.append(v)
    return out


def views_num(s):
    m = re.search(r"([\d.,]+)\s*([KMB]?)", (s or "").upper())
    if not m:
        return 0
    n = float(m.group(1).replace(",", ""))
    return int(n * {"": 1, "K": 1e3, "M": 1e6, "B": 1e9}[m.group(2)])


# ---------------- handler ----------------
class H(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def _json(self, obj, code=200):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(data)

    def _err(self, e):
        self._json({"error": str(e)[:300]}, 502)

    def _body(self):
        try:
            return json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)) or 0) or b"{}")
        except Exception:
            return {}

    def do_GET(self):  # noqa: N802
        p = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(p.query)
        try:
            if p.path == "/favicon.ico":
                self.send_response(204)
                self.end_headers()
                return
            if p.path == "/api/rss":
                feed = q.get("feed", ["topgrossingapplications"])[0]
                limit = q.get("limit", ["200"])[0]
                genre = q.get("genre", [""])[0]
                country = q.get("country", ["us"])[0]
                url = f"{ITUNES}/{country}/rss/{feed}/limit={limit}"
                if genre:
                    url += f"/genre={genre}"
                self._json(json.loads(proxy(url + "/json").decode("utf-8", "ignore")))
                return
            if p.path == "/api/lookup":
                self._json(get_json(
                    f"{ITUNES}/lookup?id={urllib.parse.quote(q.get('ids', [''])[0])}&country=us"))
                return
            if p.path == "/api/search":
                # live whole-store search (Apple caps at ~200/query)
                term = q.get("term", [""])[0]
                self._json(get_json(
                    f"{ITUNES}/search?term={urllib.parse.quote(term)}&country=us&entity=software&limit=200"))
                return
            if p.path == "/api/reviews":
                # Apple review RSS is flaky: `entry` may be missing entirely
                # (happens for some top apps), a single dict, or a list.
                # Normalize server-side so the UI never crashes.
                aid = q.get("id", [""])[0]
                try:
                    raw = json.loads(proxy(
                        f"{ITUNES}/us/rss/customerreviews/page=1/id={urllib.parse.quote(aid)}/sortby=mostrecent/json?cc=us"
                    ).decode("utf-8", "ignore"))
                except Exception as ex:  # noqa: BLE001
                    self._json({"reviews": [], "total": 0, "error": str(ex)[:200]})
                    return
                feed = raw.get("feed", {}) if isinstance(raw, dict) else {}
                entry = feed.get("entry")
                if isinstance(entry, dict):
                    entry = [entry]
                if not isinstance(entry, list):
                    entry = []

                def txt(node, key):
                    try:
                        return node.get(key, {}).get("label", "")
                    except Exception:
                        return ""

                out = []
                for r in entry[:25]:
                    if not isinstance(r, dict):
                        continue
                    try:
                        out.append({
                            "author": txt(r.get("author", {}), "name"),
                            "rating": int(txt(r, "im:rating") or 0),
                            "title": txt(r, "title"),
                            "body": txt(r, "content")[:600],
                            "date": txt(r, "updated")[:10],
                            "version": txt(r, "im:version"),
                        })
                    except Exception:
                        continue
                self._json({"reviews": out, "total": len(out)})
                return
            if p.path == "/api/status":
                c = db()
                n = c.execute("SELECT COUNT(*) n FROM apps").fetchone()["n"]
                tiers = {r["tier"]: r["n"] for r in
                         c.execute("SELECT tier, COUNT(*) n FROM apps GROUP BY tier")}
                w = c.execute("SELECT COUNT(*) n FROM watch").fetchone()["n"]
                c.close()
                self._json({"apps": n, "tiers": tiers, "watch": w, "build": dict(BUILD)})
                return
            if p.path == "/api/apps":
                # paginated library: search, cat, tier, sort, page, per, filters
                s = q.get("search", [""])[0].strip()
                scope = q.get("scope", ["all"])[0]
                cat, tier = q.get("cat", [""])[0], q.get("tier", [""])[0]
                sort, page = q.get("sort", ["rev"])[0], max(1, int(q.get("page", ["1"])[0] or 1))
                per = min(200, max(20, int(q.get("per", ["100"])[0] or 100)))
                mr = float(q.get("mr", ["0"])[0] or 0)
                mdl = float(q.get("mdl", ["0"])[0] or 0)
                mrate = float(q.get("mrate", ["0"])[0] or 0)
                exclude_cats = q.get("exclude_cats", [""])[0]
                rel_after = q.get("rel_after", [""])[0]
                price_filter = q.get("price", [""])[0]

                where, args = ["rev>=?", "dl>=?", "rating>=?"], [mr, mdl, mrate]
                if s:
                    if scope == "title":
                        where.append("title LIKE ?")
                        args.append(f"%{s}%")
                    elif scope == "dev":
                        where.append("dev LIKE ?")
                        args.append(f"%{s}%")
                    elif scope == "bundle":
                        where.append("(bundle LIKE ? OR id=?)")
                        args += [f"%{s}%", s]
                    else:
                        where.append("(title LIKE ? OR dev LIKE ? OR bundle LIKE ? OR id=?)")
                        args += [f"%{s}%", f"%{s}%", f"%{s}%", s]
                if cat:
                    where.append("cat=?")
                    args.append(cat)
                if exclude_cats:
                    for ex in [c.strip() for c in exclude_cats.split(",") if c.strip()]:
                        where.append("cat != ?")
                        args.append(ex)
                if rel_after:
                    where.append("rel >= ?")
                    args.append(rel_after)
                if price_filter == "free":
                    where.append("price = 0")
                elif price_filter == "paid":
                    where.append("price > 0")
                if tier:
                    where.append("tier=?")
                    args.append(int(tier))
                w = "WHERE " + " AND ".join(where)
                order = {"rev": "rev DESC", "dl": "dl DESC", "ratings": "rc DESC",
                         "rank": "tier, rank", "growth": "growth DESC",
                         "new": "rel DESC"}.get(sort, "rev DESC")
                c = db()
                total = c.execute(f"SELECT COUNT(*) n FROM apps {w}", args).fetchone()["n"]
                raw_rows = [dict(r) for r in c.execute(
                    f"SELECT * FROM apps {w} ORDER BY {order} LIMIT ? OFFSET ?",
                    args + [per, (page - 1) * per])]
                cats = [r["cat"] for r in c.execute("SELECT DISTINCT cat FROM apps WHERE cat IS NOT NULL AND cat != '' ORDER BY cat")]
                # Batch-fetch snapshot histories for this page (single query).
                snap_map = {}
                if raw_rows:
                    page_ids = [str(r["id"]) for r in raw_rows]
                    ph = ",".join("?" for _ in page_ids)
                    for s in c.execute(
                            f"SELECT app_id, rev FROM snaps WHERE app_id IN ({ph}) ORDER BY app_id, date",
                            page_ids):
                        snap_map.setdefault(s["app_id"], []).append(s["rev"])
                c.close()

                # Enrich each row with honest growth + sparkline from REAL snapshots.
                # Single snapshot date so far => growth None, flat 2-point spark.
                # Never fabricate. After 2+ build dates this becomes real.
                enriched_rows = []
                for r in raw_rows:
                    pts = snap_map.get(str(r.get("id") or ""), [])
                    if len(pts) >= 2 and pts[0]:
                        r["growth"] = round((pts[-1] - pts[0]) / pts[0], 4)
                        r["spark"] = pts[-12:]
                    elif len(pts) == 1:
                        r["growth"] = None
                        r["spark"] = [pts[0]] * 2
                    else:
                        r["growth"] = None
                        r["spark"] = []
                    enriched_rows.append(r)

                self._json({"total": total, "page": page, "per": per, "rows": enriched_rows, "cats": cats})
                return
            if p.path == "/api/stats":
                # whole-library aggregates: distribution buckets, top cats,
                # combined totals, tier-1 rank curve sample for the charts page
                c = db()
                b = c.execute("""SELECT
                  SUM(CASE WHEN rev<100000 THEN 1 ELSE 0 END) b0,
                  SUM(CASE WHEN rev>=100000 AND rev<500000 THEN 1 ELSE 0 END) b1,
                  SUM(CASE WHEN rev>=500000 AND rev<1000000 THEN 1 ELSE 0 END) b2,
                  SUM(CASE WHEN rev>=1000000 AND rev<3000000 THEN 1 ELSE 0 END) b3,
                  SUM(CASE WHEN rev>=3000000 THEN 1 ELSE 0 END) b4,
                  COUNT(*) total, SUM(rev) combRev, SUM(dl) combDl
                  FROM apps""").fetchone()
                cats = [[r["cat"], r["v"], r["n"]] for r in c.execute(
                    "SELECT cat, SUM(rev) v, COUNT(*) n FROM apps GROUP BY cat ORDER BY v DESC LIMIT 12")]
                curve = [[r["rank"], r["rev"], r["title"]] for r in c.execute(
                    "SELECT rank, rev, title FROM apps WHERE tier=1 ORDER BY rank LIMIT 200")]
                c.close()
                self._json({"total": b["total"] or 0,
                            "buckets": {k: (b[k] or 0) for k in ("b0", "b1", "b2", "b3", "b4")},
                            "cats": cats, "combRev": b["combRev"] or 0,
                            "combDl": b["combDl"] or 0, "curve": curve})
                return
            if p.path == "/api/app":
                c = db()
                r = c.execute("SELECT * FROM apps WHERE id=?", (q.get("id", [""])[0],)).fetchone()
                hist = [dict(x) for x in c.execute(
                    "SELECT * FROM snaps WHERE app_id=? ORDER BY date DESC LIMIT 90",
                    (q.get("id", [""])[0],))]
                c.close()
                self._json({"app": dict(r) if r else None, "hist": hist})
                return
            if p.path == "/api/yt":
                # real YouTube results, cached 24h per query
                query = q.get("q", [""])[0]
                key = "yt:" + query.lower()
                c = db()
                row = c.execute("SELECT fetched, videos FROM yt WHERE qid=?", (key,)).fetchone()
                if row and time.time() - row["fetched"] < 86400:
                    vids = json.loads(row["videos"])
                else:
                    vids = yt_search(query + " app")
                    c.execute("INSERT OR REPLACE INTO yt(qid,fetched,videos) VALUES(?,?,?)",
                              (key, int(time.time()), json.dumps(vids)))
                    c.commit()
                c.close()
                tot = sum(views_num(v["views"]) for v in vids)
                self._json({"videos": vids, "totalViews": tot})
                return
            if p.path == "/api/watch":
                c = db()
                rows = [dict(r) for r in c.execute(
                    """SELECT w.added, a.* FROM watch w LEFT JOIN apps a ON a.id=w.app_id
                       ORDER BY w.added DESC""")]
                c.close()
                self._json({"rows": rows})
                return
            if p.path == "/api/build/start":
                force = q.get("force", ["0"])[0] == "1"
                with BUILD_LOCK:
                    running = BUILD["running"]
                if not running or force:
                    if force:
                        with BUILD_LOCK:
                            BUILD["running"] = False
                    threading.Thread(target=build_job, daemon=True).start()
                    self._json({"started": True, "forced": force})
                else:
                    self._json({"started": False, "reason": "already running"})
                return
            if p.path == "/api/build/progress":
                self._json(dict(BUILD))
                return
        except Exception as e:  # noqa: BLE001
            self._err(e)
            return
        super().do_GET()

    def do_POST(self):  # noqa: N802
        p = urllib.parse.urlparse(self.path)
        try:
            if p.path == "/api/watch":
                aid = self._body().get("id", "")
                c = db()
                c.execute("INSERT OR IGNORE INTO watch(app_id,added) VALUES(?,?)", (aid, today()))
                c.commit()
                c.close()
                self._json({"ok": True})
                return
            if p.path == "/api/import":
                # import live-search hits into the library (tier 0 = searched)
                items = self._body().get("items", [])
                c = db()
                n = 0
                for r in items:
                    aid = str(r.get("trackId"))
                    if c.execute("SELECT 1 FROM apps WHERE id=?", (aid,)).fetchone():
                        continue
                    rc = r.get("userRatingCount") or 0
                    rev, dl = estimate(999, rc, r.get("primaryGenreName") or "", 4)
                    c.execute("""INSERT INTO apps(id,title,dev,icon,cat,price,rating,rc,ver,rel,
                      descc,shots,url,bundle,tier,rank,genre,country,rev,dl,growth,updated)
                      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                              (aid, r.get("trackName"), r.get("artistName"), r.get("artworkUrl100"),
                               r.get("primaryGenreName") or "", r.get("price") or 0,
                               r.get("averageUserRating") or 0, rc, r.get("version"),
                               r.get("releaseDate"), (r.get("description") or "")[:1500],
                               json.dumps((r.get("screenshotUrls") or [])[:6]),
                               r.get("trackViewUrl"), r.get("bundleId"), 0, 999, "", "us",
                               rev, dl, None, today()))
                    n += 1
                c.commit()
                c.close()
                self._json({"imported": n})
                return
        except Exception as e:  # noqa: BLE001
            self._err(e)
            return
        self._json({"error": "not found"}, 404)

    def do_DELETE(self):  # noqa: N802
        p = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(p.query)
        try:
            if p.path == "/api/watch":
                c = db()
                c.execute("DELETE FROM watch WHERE app_id=?", (q.get("id", [""])[0],))
                c.commit()
                c.close()
                self._json({"ok": True})
                return
        except Exception as e:  # noqa: BLE001
            self._err(e)
            return
        self._json({"error": "not found"}, 404)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8001"))
    db().close()
    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    print(f"serving on http://localhost:{port}")
    srv.serve_forever()
