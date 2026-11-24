from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, quote, urlencode
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

COVER_CACHE = {}
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


def search_cover_images(query):
    try:
        return google_image_search(query)
    except Exception:
        return []



class JoglumeHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/covers":
            query = parse_qs(parsed.query).get("q", [""])[0].strip()
            if not query:
                return self.send_json({"images": []})

            cache_key = query.casefold()
            cached = COVER_CACHE.get(cache_key)
            if cached and time.time() - cached[0] < COVER_CACHE_TTL:
                return self.send_json({"images": cached[1], "cached": True})

            images = search_cover_images(query)
            COVER_CACHE[cache_key] = (time.time(), images)
            return self.send_json({
                "images": images,
                "query": query.replace('"', ""),
                "sources": ["Google Imagens — páginas e sites originais"]
            })
        return super().do_GET()

    def send_json(self, payload, status=200):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
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
    print(f"Joglume disponível em http://{host}:{port}")
    print("Capas: pesquisa em múltiplos mecanismos de imagens.")
    print("PSP e PS2 habilitados com isolamento de origem cruzada.")
    if host in ("127.0.0.1", "localhost"):
        threading.Timer(0.8, lambda: webbrowser.open(f"http://localhost:{port}")).start()
    server.serve_forever()
