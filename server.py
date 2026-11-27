from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, quote, urlencode, unquote
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
import threading
import webbrowser
import json
import re
import html
import time
import os
import unicodedata
import difflib
import hashlib

import base64
import hmac
import io
import secrets
import sqlite3
from contextlib import contextmanager
import zipfile
from http.cookies import SimpleCookie
from datetime import datetime, timezone

def save_db_path():
    configured = os.environ.get("SAVE_DB_PATH")
    if configured:
        return configured
    if os.path.isdir("/data") and os.access("/data", os.W_OK):
        return "/data/joglume-save-cloud.sqlite3"
    folder = os.path.join(os.path.dirname(__file__), "data")
    os.makedirs(folder, exist_ok=True)
    return os.path.join(folder, "save-cloud.sqlite3")

SAVE_DB = save_db_path()
SAVE_DB_LOCK = threading.RLock()
SAVE_COOKIE = "joglume_session"

@contextmanager
def save_db():
    connection = sqlite3.connect(SAVE_DB, timeout=20)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA foreign_keys=ON")
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()

def init_save_db():
    folder = os.path.dirname(SAVE_DB)
    if folder:
        os.makedirs(folder, exist_ok=True)
    with SAVE_DB_LOCK, save_db() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_sub TEXT UNIQUE,
                email TEXT, display_name TEXT, created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS saves (
                user_id TEXT NOT NULL, game_id TEXT NOT NULL, game_name TEXT NOT NULL,
                platform TEXT NOT NULL, filename TEXT NOT NULL, data BLOB NOT NULL,
                updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, game_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS save_versions (
                id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
                game_id TEXT NOT NULL, filename TEXT NOT NULL, data BLOB NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS save_versions_lookup ON save_versions(user_id, game_id, created_at DESC);
        """)
        db.execute("INSERT OR IGNORE INTO settings(key, value) VALUES('session_secret', ?)", (secrets.token_urlsafe(48),))

def session_secret():
    with SAVE_DB_LOCK, save_db() as db:
        return db.execute("SELECT value FROM settings WHERE key='session_secret'").fetchone()["value"]

def make_session_cookie(user_id, max_age=2592000):
    expires = int(time.time()) + max_age
    payload = f"{user_id}.{expires}"
    signature = hmac.new(session_secret().encode(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{signature}"

def read_session_cookie(handler):
    cookie = SimpleCookie()
    try:
        cookie.load(handler.headers.get("Cookie", ""))
        user_id, expires, signature = cookie[SAVE_COOKIE].value.rsplit(".", 2)
        payload = f"{user_id}.{expires}"
        expected = hmac.new(session_secret().encode(), payload.encode(), hashlib.sha256).hexdigest()
        if int(expires) < int(time.time()) or not hmac.compare_digest(signature, expected):
            return None
        return user_id
    except Exception:
        return None

def create_guest():
    user_id = "guest_" + secrets.token_urlsafe(24)
    with SAVE_DB_LOCK, save_db() as db:
        db.execute("INSERT INTO users(id, provider, created_at) VALUES(?, 'guest', ?)", (user_id, int(time.time())))
    return user_id

def ensure_user(handler):
    user_id = read_session_cookie(handler)
    if user_id:
        with SAVE_DB_LOCK, save_db() as db:
            exists = db.execute("SELECT id FROM users WHERE id=?", (user_id,)).fetchone()
        if exists:
            return user_id
    user_id = create_guest()
    handler._save_cookie = make_session_cookie(user_id)
    return user_id

def check_same_origin(handler):
    origin = handler.headers.get("Origin")
    return not origin or urlparse(origin).netloc.lower() == handler.headers.get("Host", "").lower()

def safe_game_id(value):
    value = str(value or "").strip().lower()
    return value if re.fullmatch(r"[a-z0-9_-]{3,90}", value) else None

def google_identity(credential):
    client_id = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
    if not client_id:
        raise ValueError("Login do Google ainda não foi configurado no Joglume.")
    if not isinstance(credential, str) or len(credential) > 12000:
        raise ValueError("Credencial do Google inválida.")
    info = fetch_json("https://oauth2.googleapis.com/tokeninfo?" + urlencode({"id_token": credential}), timeout=12)
    if info.get("aud") != client_id or info.get("iss") not in ("accounts.google.com", "https://accounts.google.com"):
        raise ValueError("Credencial Google inválida para este aplicativo.")
    if int(info.get("exp", "0")) <= int(time.time()) or info.get("email_verified") not in ("true", True):
        raise ValueError("A identidade Google expirou ou não foi verificada.")
    subject = str(info.get("sub") or "")
    if not subject:
        raise ValueError("Não foi possível identificar a conta Google.")
    return {"id": "google_" + hashlib.sha256(subject.encode()).hexdigest()[:40], "sub": subject,
            "email": str(info.get("email") or "")[:254], "name": str(info.get("name") or "Conta Google")[:120]}

def merge_guest_saves(db, guest_id, google_id):
    if not guest_id or not guest_id.startswith("guest_") or guest_id == google_id:
        return
    rows = db.execute("SELECT * FROM saves WHERE user_id=?", (guest_id,)).fetchall()
    for row in rows:
        current = db.execute("SELECT updated_at FROM saves WHERE user_id=? AND game_id=?", (google_id, row["game_id"])).fetchone()
        if not current or row["updated_at"] > current["updated_at"]:
            db.execute("""INSERT INTO saves(user_id, game_id, game_name, platform, filename, data, updated_at)
                VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, game_id) DO UPDATE SET
                game_name=excluded.game_name, platform=excluded.platform, filename=excluded.filename,
                data=excluded.data, updated_at=excluded.updated_at""",
                (google_id, row["game_id"], row["game_name"], row["platform"], row["filename"], row["data"], row["updated_at"]))
    db.execute("INSERT INTO save_versions(user_id, game_id, filename, data, created_at) SELECT ?, game_id, filename, data, created_at FROM save_versions WHERE user_id=?", (google_id, guest_id))
    db.execute("DELETE FROM users WHERE id=?", (guest_id,))

init_save_db()

COVER_CACHE = {}
CATALOG_CACHE = {}
CATALOG_CACHE_TTL = 6 * 60 * 60
CATALOG_LOCK = threading.RLock()
CATALOG_SOURCE_LOCKS = {}
COVER_CACHE_TTL = 60 * 60 * 12
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"


def normalize_search_text(value):
    value = unicodedata.normalize("NFKD", str(value or ""))
    value = "".join(char for char in value if not unicodedata.combining(char))
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def request_text(url, referer=None):
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
    }
    if referer:
        headers["Referer"] = referer
    request = Request(url, headers=headers)
    with urlopen(request, timeout=16) as response:
        return response.read(10_000_000).decode("utf-8", errors="ignore")


def duckduckgo_image_search(query):
    start_url = "https://duckduckgo.com/?" + urlencode({"q": query, "iax": "images", "ia": "images"})
    page = request_text(start_url)
    token_match = re.search(r'vqd=["\']([^"\']+)["\']', page)
    if not token_match:
        token_match = re.search(r"vqd=([0-9-]+)", page)
    if not token_match:
        return []

    token = token_match.group(1)
    api_url = "https://duckduckgo.com/i.js?" + urlencode({
        "q": query, "o": "json", "l": "br-pt", "vqd": token, "f": ",,,,,"
    })
    data = json.loads(request_text(api_url, "https://duckduckgo.com/"))
    results = []
    for item in data.get("results", []):
        image_url = item.get("image") or item.get("thumbnail")
        source_url = item.get("url") or item.get("source")
        if image_url and image_url.startswith(("http://", "https://")):
            results.append({
                "url": image_url,
                "source_url": source_url if isinstance(source_url, str) and source_url.startswith(("http://", "https://")) else "",
                "title": item.get("title") or item.get("title_orig") or ""
            })
    return results


def bing_image_search(query):
    search_url = "https://www.bing.com/images/search?" + urlencode({"q": query})
    page = request_text(search_url)
    results = []
    for match in re.findall(r'\bm="([^"]+)"', page):
        try:
            item = json.loads(html.unescape(match))
        except (json.JSONDecodeError, TypeError):
            continue
        image_url = item.get("murl")
        if image_url and image_url.startswith(("http://", "https://")):
            results.append({
                "url": image_url,
                "source_url": item.get("purl") or "",
                "title": item.get("t") or item.get("desc") or ""
            })
    return results


def google_image_search(query):
    search_url = "https://www.google.com/search?" + urlencode({
        "tbm": "isch",
        "q": query,
        "ijn": "0"
    })
    page = request_text(search_url)
    page = html.unescape(page)

    def decode_google_url(value):
        value = value.replace("\\u003d", "=").replace("\\u0026", "&")
        value = value.replace("\\/", "/").replace("\\\\", "")
        return value

    image_urls = []
    source_urls = []
    for pattern in (r'"ou":"([^"]+)"', r'"imgurl":"([^"]+)"'):
        image_urls.extend(re.findall(pattern, page, re.IGNORECASE))
    for pattern in (r'"ru":"([^"]+)"', r'"page_url":"([^"]+)"'):
        source_urls.extend(re.findall(pattern, page, re.IGNORECASE))

    results = []
    seen = set()
    for index, raw_url in enumerate(image_urls):
        image_url = decode_google_url(raw_url)
        if not image_url.startswith(("http://", "https://")):
            continue
        host = urlparse(image_url).netloc.lower()
        if not host or any(domain in host for domain in ("google.com", "gstatic.com", "googleusercontent.com")):
            continue
        if image_url in seen:
            continue
        seen.add(image_url)

        source_url = ""
        if index < len(source_urls):
            candidate_source = decode_google_url(source_urls[index])
            if candidate_source.startswith(("http://", "https://")):
                source_url = candidate_source

        results.append({
            "url": image_url,
            "source_url": source_url,
            "title": ""
        })
        if len(results) >= 50:
            break
    return results



PORTAL_DOMAINS = [
    "poki.com", "crazygames.com", "y8.com", "lagged.com",
    "hackedfreegames.com", "gamedistribution.com", "gamemonetize.com",
    "friv.com", "kongregate.com", "armorgames.com", "newgrounds.com",
    "miniplay.com", "addictinggames.com", "gamepix.com", "gameflare.com",
    "silvergames.com", "coolmathgames.com", "1001games.com", "pacogames.com",
    "gamaverse.com", "roundgames.com", "numuki.com"
]


def extract_meta_image(page):
    patterns = [
        r"""<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']""",
        r"""<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']""",
        r"""<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']"""
    ]
    for pattern in patterns:
        match = re.search(pattern, page, re.I)
        if match:
            image_url = html.unescape(match.group(1)).strip()
            if image_url.startswith("//"):
                image_url = "https:" + image_url
            if image_url.startswith(("http://", "https://")):
                return image_url
    return None


def validate_cover_image(image_url):
    try:
        request = Request(image_url, headers={
            "User-Agent": USER_AGENT,
            "Range": "bytes=0-2047"
        })
        with urlopen(request, timeout=10) as response:
            content_type = response.headers.get("Content-Type", "").lower()
            return response.status in (200, 206) and content_type.startswith("image/")
    except Exception:
        return False


def search_portal_cover(game_name):
    normalized = normalize_search_text(game_name)
    if len(normalized) < 2:
        return None

    query = f'"{game_name}" game (' + " OR ".join(f"site:{domain}" for domain in PORTAL_DOMAINS) + ")"
    search_url = "https://html.duckduckgo.com/html/?" + urlencode({"q": query})
    try:
        page = request_text(search_url)
    except Exception:
        return None

    links = re.findall(r"""<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["']""", page, re.I)
    candidates = []
    for raw_link in links:
        link = html.unescape(raw_link)
        if "uddg=" in link:
            link = parse_qs(urlparse(link).query).get("uddg", [link])[0]
        link = unquote(link)
        parsed = urlparse(link)
        host = (parsed.hostname or "").lower()
        if parsed.scheme not in ("http", "https") or not any(host == domain or host.endswith("." + domain) for domain in PORTAL_DOMAINS):
            continue
        if link not in candidates:
            candidates.append(link)

    for page_url in candidates[:12]:
        try:
            page_html = request_text(page_url)
            image_url = extract_meta_image(page_html)
            if not image_url or not validate_cover_image(image_url):
                continue
            title_match = re.search(r"""<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']""", page_html, re.I)
            if not title_match:
                title_match = re.search(r'<title[^>]*>(.*?)</title>', page_html, re.I | re.S)
            page_title = html.unescape(re.sub(r"<[^>]+>", " ", title_match.group(1))).strip() if title_match else ""
            title_normalized = normalize_search_text(page_title)
            if not title_normalized:
                continue

            title_words = set(normalized.split())
            page_words = set(title_normalized.split())
            meaningful_words = {word for word in title_words if len(word) > 1}
            matched_words = meaningful_words & page_words
            coverage = len(matched_words) / max(1, len(meaningful_words))

            if len(meaningful_words) >= 2:
                if len(matched_words) < 2 or coverage < 0.75:
                    continue
            elif not meaningful_words.issubset(page_words):
                continue

            return {
                "name": game_name,
                "url": image_url,
                "match": "portal",
                "source": urlparse(page_url).netloc,
                "page": page_url
            }
        except Exception:
            continue
    return None


def cover_search_terms(game_name):
    normalized = normalize_search_text(game_name)
    if not normalized:
        return []

    aliases = {
        "fnaf": ["Five Nights at Freddy's"],
        "fnaf 3": ["Five Nights at Freddy's 3", "Five Nights at Freddy's"],
        "fnaf 4": ["Five Nights at Freddy's 4", "Five Nights at Freddy's"],
        "fnaf sister location": ["Five Nights at Freddy's Sister Location", "Five Nights at Freddy's"],
        "flash sonic": ["Sonic the Hedgehog", "Sonic"],
    }
    if normalized in aliases:
        return aliases[normalized]

    if "subway surfers" in normalized:
        return ["Subway Surfers"]
    if "mario" in normalized:
        return ["Super Mario"]
    if "sonic" in normalized:
        return ["Sonic the Hedgehog", "Sonic"]
    if normalized.startswith("minecraft"):
        return ["Minecraft"]

    return [game_name]


def find_automatic_cover(game_name):
    key = normalize_search_text(game_name)
    if not key:
        return None
    cached = COVER_CACHE.get(key)
    if cached and time.time() - cached["time"] < COVER_CACHE_TTL:
        return cached["image"]

    image = None
    for search_name in cover_search_terms(game_name):
        image = search_portal_cover(search_name)
        if image:
            image["requested_name"] = game_name
            image["searched_name"] = search_name
            break

    COVER_CACHE[key] = {"time": time.time(), "image": image}
    return image


def fetch_json(url, headers=None, timeout=25):
    request_headers = {
        "User-Agent": "Joglume/1.0 (+https://joglume-production.up.railway.app)",
        "Accept": "application/json"
    }
    if headers:
        request_headers.update(headers)
    request = Request(url, headers=request_headers)
    with urlopen(request, timeout=timeout) as response:
        return json.loads(response.read(25_000_000).decode("utf-8", errors="ignore"))


def catalog_cache_key(source):
    identity = {
        "owner": str(source.get("owner", "")).lower(),
        "repo": str(source.get("repo", "")).lower(),
        "branch": source.get("branch") or "",
        "path": (source.get("path") or "").strip("/"),
        "recursive": source.get("recursive") is not False
    }
    return hashlib.sha256(json.dumps(identity, sort_keys=True).encode("utf-8")).hexdigest()


def fetch_catalog_from_source(source):
    owner = str(source.get("owner", "")).strip()
    repo = str(source.get("repo", "")).strip()
    branch = str(source.get("branch") or "").strip()
    directory = str(source.get("path") or "").strip("/")
    recursive = source.get("recursive") is not False

    if not re.fullmatch(r"[A-Za-z0-9_.-]+", owner) or not re.fullmatch(r"[A-Za-z0-9_.-]+", repo):
        raise ValueError("Fonte inválida.")

    if not branch:
        repo_data = fetch_json(f"https://api.github.com/repos/{quote(owner)}/{quote(repo)}")
        branch = repo_data.get("default_branch") or "main"

    prefix = directory + "/" if directory else ""
    jsdelivr_url = f"https://data.jsdelivr.com/v1/package/gh/{quote(owner)}/{quote(repo)}@{quote(branch, safe='')}/flat"

    try:
        data = fetch_json(jsdelivr_url)
        paths = []
        sizes = {}
        for item in data.get("files", []):
            path = str(item.get("name", "")).lstrip("/")
            if not path or (prefix and not (path.startswith(prefix) or path == directory)):
                continue
            relative = path[len(prefix):] if prefix and path.startswith(prefix) else path
            if not recursive and "/" in relative:
                continue
            paths.append(path)
            sizes[path] = item.get("size")
        provider = "jsdelivr"
    except Exception:
        tree_url = f"https://api.github.com/repos/{quote(owner)}/{quote(repo)}/git/trees/{quote(branch, safe='')}?recursive=1"
        data = fetch_json(tree_url, {"Accept": "application/vnd.github+json"})
        if data.get("truncated"):
            raise RuntimeError("A lista desta fonte é grande demais para uma única consulta. Será necessário paginar a leitura.")
        paths = []
        sizes = {}
        for item in data.get("tree", []):
            if item.get("type") != "blob":
                continue
            path = str(item.get("path", ""))
            if prefix and not (path.startswith(prefix) or path == directory):
                continue
            relative = path[len(prefix):] if prefix and path.startswith(prefix) else path
            if not recursive and "/" in relative:
                continue
            paths.append(path)
            sizes[path] = item.get("size")
        provider = "github-api"

    return {
        "branch": branch,
        "files": paths,
        "sizes": sizes,
        "provider": provider,
        "updatedAt": int(time.time() * 1000)
    }


def get_source_catalog(source, force=False):
    key = catalog_cache_key(source)
    with CATALOG_LOCK:
        source_lock = CATALOG_SOURCE_LOCKS.setdefault(key, threading.Lock())

    with source_lock:
        now = time.time()
        with CATALOG_LOCK:
            cached = CATALOG_CACHE.get(key)
            if cached and not force and now - cached["cachedAt"] < CATALOG_CACHE_TTL:
                return {**cached["data"], "cached": True, "stale": False}

        try:
            data = fetch_catalog_from_source(source)
            with CATALOG_LOCK:
                CATALOG_CACHE[key] = {
                    "data": data,
                    "cachedAt": time.time(),
                    "lastAttemptAt": time.time(),
                    "source": dict(source)
                }
            return {**data, "cached": False, "stale": False}
        except Exception as error:
            with CATALOG_LOCK:
                cached = CATALOG_CACHE.get(key)
                if cached:
                    cached["lastAttemptAt"] = time.time()
            if cached:
                return {**cached["data"], "cached": True, "stale": True, "warning": str(error)}
            raise


def refresh_catalogs_forever():
    while True:
        time.sleep(60)
        now = time.time()
        with CATALOG_LOCK:
            expired_sources = [
                dict(entry["source"])
                for entry in CATALOG_CACHE.values()
                if now - entry["cachedAt"] >= CATALOG_CACHE_TTL
                and now - entry.get("lastAttemptAt", 0) >= 15 * 60
            ]
        for source in expired_sources:
            try:
                get_source_catalog(source, force=True)
            except Exception:
                pass



def load_manual_covers(platform):
    allowed_platforms = {"html5", "flash", "gba", "gb", "nes", "snes", "segaMD", "psx", "arcade", "psp"}
    if platform not in allowed_platforms:
        return []

    covers_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "capas",
        platform,
        "capa.txt"
    )
    entries = []
    try:
        with open(covers_path, "r", encoding="utf-8-sig") as file:
            for line in file:
                line = line.strip()
                if not line or line.startswith("#") or ":" not in line:
                    continue
                name, url = line.split(":", 1)
                name = name.strip()
                url = url.strip()
                if not name or not re.match(r"^https?://", url, re.IGNORECASE):
                    continue
                entries.append({"name": name, "url": url})
    except (OSError, UnicodeError):
        return []
    return entries


def find_manual_cover(game_name, platform):
    target = normalize_search_text(game_name)
    if not target:
        return None

    def cover_key(value):
        value = str(value or "")
        value = re.sub(r"\s*\((?:U|E|J|W)\)\s*", " ", value, flags=re.I)
        value = re.sub(
            r"\s*\((?=[^)]*\b(?:PAL|USA|Europe|Japan|World|Australia|Korea|Brazil|Canada|En|Fr|De|Es|It|Nl|Sv|Da|Pt|Rev(?:ision)?|V\d+(?:\.\d+)*|Beta|Alpha)\b)[^)]*\)",
            " ",
            value,
            flags=re.I
        )
        value = re.sub(r"\s*\[(?:!|a|b|h|t|o|p|f|x|\?|\s*)\]\s*", " ", value, flags=re.I)
        return normalize_search_text(value)

    target_key = cover_key(game_name)
    entries = load_manual_covers(platform)
    normalized_entries = [
        (cover_key(entry["name"]), entry)
        for entry in entries
    ]

    for candidate, entry in normalized_entries:
        if candidate and candidate == target_key:
            return {"name": entry["name"], "url": entry["url"], "match": "normalized-exact"}

    family_matches = [
        (candidate, entry)
        for candidate, entry in normalized_entries
        if len(candidate) >= 5
        and len(candidate.split()) >= 2
        and target_key.startswith(candidate + " ")
    ]
    if family_matches:
        candidate, entry = max(family_matches, key=lambda item: len(item[0]))
        return {
            "name": entry["name"],
            "url": entry["url"],
            "match": "series-fallback",
            "matched_family": candidate
        }

    return None



class JoglumeHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/ps2" or parsed.path.startswith("/ps2/"):
            return self.handle_ps2_proxy(parsed.path, parsed.query)
        if parsed.path == "/api/rom-proxy":
            target = parse_qs(parsed.query).get("url", [""])[0]
            return self.handle_rom_proxy(target)
        if parsed.path == "/api/save-cloud/session": return self.handle_save_session()
        if parsed.path == "/api/save-cloud/saves": return self.handle_save_list()
        if parsed.path == "/api/save-cloud/export": return self.handle_save_export()
        if parsed.path.startswith("/api/save-cloud/saves/") and parsed.path.endswith("/file"): return self.handle_save_file(parsed.path)
        if parsed.path == "/api/catalog":
            return self.send_json({"error": "Use POST para consultar o catálogo."}, 405)
        if parsed.path == "/api/covers":
            query = parse_qs(parsed.query).get("q", [""])[0].strip()
            if not query:
                return self.send_json({"image": None})
            platform = parse_qs(parsed.query).get("platform", [""])[0].strip()
            cover = find_manual_cover(query, platform)
            if not cover and platform == "html5":
                cover = find_automatic_cover(query)
            return self.send_json({"image": cover, "query": query, "platform": platform, "source": f"capas/{platform}/capa.txt" if cover else None})
        return super().do_GET()

    def handle_rom_proxy(self, target):
        parsed = urlparse(target)
        host = (parsed.hostname or "").lower()
        allowed = (
            host == "raw.githubusercontent.com"
            or host == "github.com"
            or host == "objects.githubusercontent.com"
            or host.endswith(".githubusercontent.com")
            or host == "archive.org"
            or host.endswith(".archive.org")
        )
        if parsed.scheme != "https" or not allowed or parsed.username or parsed.password:
            return self.send_json({"error": "A fonte da ROM não é permitida pelo proxy."}, 403)

        headers = {
            "User-Agent": "Joglume/1.0",
            "Accept": "*/*"
        }
        byte_range = self.headers.get("Range")
        if byte_range:
            headers["Range"] = byte_range
        try:
            response = urlopen(Request(target, headers=headers), timeout=90)
            final = urlparse(response.geturl())
            final_host = (final.hostname or "").lower()
            final_allowed = (
                final_host == "raw.githubusercontent.com"
                or final_host == "github.com"
                or final_host == "objects.githubusercontent.com"
                or final_host.endswith(".githubusercontent.com")
                or final_host == "archive.org"
                or final_host.endswith(".archive.org")
            )
            if final.scheme != "https" or not final_allowed:
                response.close()
                return self.send_json({"error": "A fonte redirecionou para um endereço não permitido."}, 403)

            self.send_response(response.status)
            self.send_header("Content-Type", response.headers.get("Content-Type", "application/octet-stream"))
            for header in ("Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag"):
                value = response.headers.get(header)
                if value:
                    self.send_header(header, value)
            self.send_header("Cache-Control", "private, max-age=300")
            self.send_header("Content-Disposition", "inline")
            self.end_headers()
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)
            response.close()
        except HTTPError as error:
            return self.send_json({"error": f"A fonte recusou o arquivo (HTTP {error.code})."}, error.code)
        except (URLError, TimeoutError, OSError) as error:
            return self.send_json({"error": "Não foi possível buscar a ROM na fonte informada."}, 502)

    def handle_ps2_proxy(self, path, query):
        suffix = path[len("/ps2"):].lstrip("/")
        target = "https://tabstationtoo.github.io/TabStationToo/"
        if suffix:
            target += suffix
        if query:
            target += "?" + query
        try:
            headers = {"User-Agent": "Joglume/1.0", "Accept": "*/*"}
            byte_range = self.headers.get("Range")
            if byte_range:
                headers["Range"] = byte_range
            response = urlopen(Request(target, headers=headers), timeout=90)
            final = urlparse(response.geturl())
            if final.scheme != "https" or final.hostname != "tabstationtoo.github.io":
                response.close()
                return self.send_json({"error": "Não foi possível carregar o emulador PS2."}, 502)
            self.send_response(response.status)
            self.send_header("Content-Type", response.headers.get("Content-Type", "application/octet-stream"))
            for header in ("Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag"):
                value = response.headers.get(header)
                if value:
                    self.send_header(header, value)
            self.send_header("Cache-Control", "public, max-age=300")
            self.end_headers()
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)
            response.close()
        except HTTPError as error:
            return self.send_json({"error": f"O emulador PS2 respondeu com HTTP {error.code}."}, error.code)
        except (URLError, TimeoutError, OSError):
            return self.send_json({"error": "Não foi possível conectar ao emulador PS2."}, 502)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/save-cloud/google": return self.handle_google_login()
        if parsed.path != "/api/catalog":
            return self.send_json({"error": "Endpoint não encontrado."}, 404)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 100_000:
                return self.send_json({"error": "Solicitação inválida."}, 400)
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            source = payload.get("source") if isinstance(payload, dict) else None
            if not isinstance(source, dict):
                return self.send_json({"error": "Fonte inválida."}, 400)
            catalog = get_source_catalog(source, force=bool(payload.get("force")))
            return self.send_json(catalog)
        except Exception as error:
            return self.send_json({"error": str(error)}, 502)

    def do_PUT(self):
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/save-cloud/saves/") or parsed.path.endswith("/file"):
            return self.send_json({"error": "Endpoint não encontrado."}, 404)
        if not check_same_origin(self): return self.send_json({"error": "Origem não autorizada."}, 403)
        try:
            game_id = safe_game_id(parsed.path.rsplit("/", 1)[-1])
            if not game_id: return self.send_json({"error": "Identificador de jogo inválido."}, 400)
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 16 * 1024 * 1024: return self.send_json({"error": "Arquivo de save inválido ou maior que 16 MB."}, 413)
            data = self.rfile.read(length)
            user_id = ensure_user(self)
            game_name = unquote(self.headers.get("X-Game-Name", "Jogo"))[:160]
            platform = self.headers.get("X-Game-Platform", "unknown")[:32]
            filename = self.headers.get("X-Save-Filename", "save.srm")[:120]
            if not re.fullmatch(r"[A-Za-z0-9_.-]+", filename): filename = "save.srm"
            now = int(time.time())
            with SAVE_DB_LOCK, save_db() as db:
                previous = db.execute("SELECT data, filename FROM saves WHERE user_id=? AND game_id=?", (user_id, game_id)).fetchone()
                if previous and bytes(previous["data"]) != data:
                    db.execute("INSERT INTO save_versions(user_id, game_id, filename, data, created_at) VALUES(?, ?, ?, ?, ?)", (user_id, game_id, previous["filename"], previous["data"], now))
                    db.execute("DELETE FROM save_versions WHERE user_id=? AND game_id=? AND id NOT IN (SELECT id FROM save_versions WHERE user_id=? AND game_id=? ORDER BY created_at DESC LIMIT 5)", (user_id, game_id, user_id, game_id))
                db.execute("""INSERT INTO saves(user_id, game_id, game_name, platform, filename, data, updated_at)
                    VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, game_id) DO UPDATE SET
                    game_name=excluded.game_name, platform=excluded.platform, filename=excluded.filename,
                    data=excluded.data, updated_at=excluded.updated_at""",
                    (user_id, game_id, game_name, platform, filename, sqlite3.Binary(data), now))
            return self.send_json({"saved": True, "gameId": game_id, "updatedAt": now})
        except Exception as error:
            return self.send_json({"error": str(error)}, 500)

    def handle_save_session(self):
        user_id = ensure_user(self)
        with SAVE_DB_LOCK, save_db() as db:
            user = db.execute("SELECT provider, email, display_name FROM users WHERE id=?", (user_id,)).fetchone()
        return self.send_json({"userId": user_id, "identity": user["provider"] if user else "guest",
            "email": user["email"] if user else None, "displayName": user["display_name"] if user else None,
            "googleClientId": os.environ.get("GOOGLE_CLIENT_ID", ""),
            "googleConfigured": bool(os.environ.get("GOOGLE_CLIENT_ID", "").strip())})

    def handle_google_login(self):
        if not check_same_origin(self): return self.send_json({"error": "Origem não autorizada."}, 403)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 20000: return self.send_json({"error": "Solicitação inválida."}, 400)
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            identity = google_identity(payload.get("credential") if isinstance(payload, dict) else None)
            guest_id = ensure_user(self)
            now = int(time.time())
            with SAVE_DB_LOCK, save_db() as db:
                db.execute("""INSERT INTO users(id, provider, provider_sub, email, display_name, created_at)
                    VALUES(?, 'google', ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET email=excluded.email, display_name=excluded.display_name""",
                    (identity["id"], identity["sub"], identity["email"], identity["name"], now))
                merge_guest_saves(db, guest_id, identity["id"])
            self._save_cookie = make_session_cookie(identity["id"])
            return self.send_json({"signedIn": True, "identity": "google", "email": identity["email"], "displayName": identity["name"]})
        except Exception as error:
            return self.send_json({"error": str(error)}, 400)

    def handle_save_list(self):
        user_id = ensure_user(self)
        with SAVE_DB_LOCK, save_db() as db:
            rows = db.execute("SELECT game_id, game_name, platform, filename, length(data) AS size, updated_at FROM saves WHERE user_id=? ORDER BY updated_at DESC", (user_id,)).fetchall()
        return self.send_json({"saves": [dict(row) for row in rows]})

    def handle_save_file(self, path):
        user_id = ensure_user(self)
        parts = path.strip("/").split("/")
        game_id = safe_game_id(parts[-2] if len(parts) >= 2 else "")
        if not game_id: return self.send_json({"error": "Identificador inválido."}, 400)
        with SAVE_DB_LOCK, save_db() as db:
            row = db.execute("SELECT data, filename FROM saves WHERE user_id=? AND game_id=?", (user_id, game_id)).fetchone()
        if not row: return self.send_json({"error": "Nenhum save na nuvem."}, 404)
        data = bytes(row["data"])
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Disposition", "attachment; filename=" + row["filename"])
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        if getattr(self, "_save_cookie", None):
            secure = "; Secure" if "up.railway.app" in self.headers.get("Host", "") else ""
            self.send_header("Set-Cookie", f"{SAVE_COOKIE}={self._save_cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000{secure}")
        self.end_headers()
        self.wfile.write(data)

    def handle_save_export(self):
        user_id = ensure_user(self)
        with SAVE_DB_LOCK, save_db() as db:
            rows = db.execute("SELECT game_id, game_name, platform, filename, data, updated_at FROM saves WHERE user_id=? ORDER BY platform, game_name", (user_id,)).fetchall()
        output = io.BytesIO()
        manifest = []
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
            for row in rows:
                filename = re.sub(r"[^A-Za-z0-9_.-]+", "_", row["filename"] or "save.srm")
                archive.writestr(f"saves/{row['platform']}/{row['game_id']}/{filename}", bytes(row["data"]))
                manifest.append({"gameId": row["game_id"], "game": row["game_name"], "platform": row["platform"], "filename": filename, "updatedAt": row["updated_at"], "bytes": len(row["data"])})
            archive.writestr("manifest.json", json.dumps({"app": "Joglume Save Cloud", "exportedAt": datetime.now(timezone.utc).isoformat(), "saves": manifest}, ensure_ascii=False, indent=2))
        data = output.getvalue()
        self.send_response(200)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Disposition", 'attachment; filename="joglume-saves.zip"')
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, payload, status=200):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store" if self.path.startswith("/api/save-cloud/") else "public, max-age=60")
        if getattr(self, "_save_cookie", None):
            secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" or "up.railway.app" in self.headers.get("Host", "") else ""
            self.send_header("Set-Cookie", f"{SAVE_COOKIE}={self._save_cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000{secure}")
        self.end_headers()
        self.wfile.write(data)

    def end_headers(self):
        path = self.path.split("?", 1)[0]
        if path in ("/paginas/psp.html", "/paginas/ps2.html") or path == "/ps2" or path.startswith("/ps2/"):
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp" if path == "/ps2" or path.startswith("/ps2/") else "credentialless")
        super().end_headers()


if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer((host, port), JoglumeHandler)
    threading.Thread(target=refresh_catalogs_forever, daemon=True).start()
    print(f"Joglume disponível em http://{host}:{port}")
    print("Capas: listas manuais separadas por plataforma em capas/<plataforma>/capa.txt.")
    print("PSP e PS2 habilitados com isolamento de origem cruzada.")
    if host in ("127.0.0.1", "localhost"):
        threading.Timer(0.8, lambda: webbrowser.open(f"http://localhost:{port}")).start()
    server.serve_forever()
