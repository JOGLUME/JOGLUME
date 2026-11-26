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

    def do_POST(self):
        parsed = urlparse(self.path)
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

    def send_json(self, payload, status=200):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=60")
        self.end_headers()
        self.wfile.write(data)

    def end_headers(self):
        if self.path.split("?", 1)[0] in ("/paginas/psp.html", "/paginas/ps2.html"):
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "credentialless")
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
