from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, quote
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
COVER_CACHE_TTL = 60 * 60 * 24


def normalize_search_text(value):
    value = unicodedata.normalize("NFKD", str(value or ""))
    value = "".join(char for char in value if not unicodedata.combining(char))
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def bing_image_search(query):
    search_url = "https://www.bing.com/images/search?q=" + quote(query, safe="")
    request = Request(search_url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
    })
    with urlopen(request, timeout=18) as response:
        page = response.read(8_000_000).decode("utf-8", errors="ignore")

    title = normalize_search_text(query.replace('"', "").replace(" game cover", "").replace(" gameplay", ""))
    terms = [word for word in title.split() if len(word) > 2]
    if not terms:
        return []

    found = []
    seen = set()
    for match in re.findall(r'\bm="([^"]+)"', page):
        try:
            metadata = json.loads(html.unescape(match))
        except (json.JSONDecodeError, TypeError):
            continue

        image_url = metadata.get("murl")
        if not isinstance(image_url, str) or not image_url.startswith(("http://", "https://")):
            continue

        searchable = normalize_search_text(" ".join([
            str(metadata.get("t") or ""),
            str(metadata.get("desc") or ""),
            str(metadata.get("purl") or "")
        ]))
        if not all(term in searchable.split() for term in terms):
            continue

        if image_url not in seen:
            seen.add(image_url)
            found.append(image_url)
        if len(found) >= 20:
            break

    return found


def search_cover_images(query):
    return bing_image_search(query)


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

            try:
                images = search_cover_images(query)
                COVER_CACHE[cache_key] = (time.time(), images)
                self.send_json({
                    "images": images,
                    "source": "Bing Imagens",
                    "matched_title": query.replace('"', ""),
                    "verified_results": True
                })
            except (URLError, HTTPError, TimeoutError, ValueError) as error:
                self.send_json({"images": [], "error": str(error)}, 502)
            except Exception as error:
                self.send_json({"images": [], "error": str(error)}, 502)
            return
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
    print("Capas: resultados do Bing filtrados pelo título do jogo.")
    print("PSP e PS2 habilitados com isolamento de origem cruzada.")
    if host in ("127.0.0.1", "localhost"):
        threading.Timer(0.8, lambda: webbrowser.open(f"http://localhost:{port}")).start()
    server.serve_forever()
