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

COVER_CACHE = {}
COVER_CACHE_TTL = 60 * 60 * 24 * 7


def decode_google_url(value):
    value = html.unescape(value)
    value = value.replace('\\u003d', '=').replace('\\u0026', '&').replace('\\/', '/')
    try:
        value = json.loads('"' + value.replace('"', '\\"') + '"')
    except Exception:
        pass
    return value


def google_image_search(query):
    search_url = 'https://www.google.com/search?tbm=isch&hl=pt-BR&q=' + quote(query)
    request = Request(search_url, headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
    })
    with urlopen(request, timeout=12) as response:
        page = response.read(5_000_000).decode('utf-8', errors='ignore')

    patterns = [r'"ou":"(https?[^"\\]+)', r'"ou"\s*:\s*"(https?[^"\\]+)', r'\[\"(https?://[^\"]+\.(?:jpg|jpeg|png|webp)(?:\?[^\"]*)?)']
    found = []
    for pattern in patterns:
        for match in re.findall(pattern, page, flags=re.IGNORECASE):
            url = decode_google_url(match)
            if not url.startswith(('http://', 'https://')):
                continue
            if any(part in url.lower() for part in ('gstatic.com/images', 'google.com/images', 'googleusercontent.com')):
                continue
            if url not in found:
                found.append(url)
            if len(found) >= 8:
                return found
    return found


class JoglumeHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == '/api/covers':
            query = parse_qs(parsed.query).get('q', [''])[0].strip()
            if not query:
                return self.send_json({'images': []})
            cache_key = query.casefold()
            cached = COVER_CACHE.get(cache_key)
            if cached and time.time() - cached[0] < COVER_CACHE_TTL:
                return self.send_json({'images': cached[1], 'cached': True})
            try:
                images = google_image_search(query)
                COVER_CACHE[cache_key] = (time.time(), images)
                self.send_json({'images': images, 'source': 'Google Imagens'})
            except (URLError, HTTPError, TimeoutError, ValueError) as error:
                self.send_json({'images': [], 'error': str(error)}, 502)
            except Exception as error:
                self.send_json({'images': [], 'error': str(error)}, 502)
            return
        return super().do_GET()

    def send_json(self, payload, status=200):
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def end_headers(self):
        if self.path.split('?', 1)[0] in ('/paginas/psp.html', '/paginas/ps2.html'):
            self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
            self.send_header('Cross-Origin-Embedder-Policy', 'credentialless')
        super().end_headers()


if __name__ == '__main__':
    host = os.environ.get('HOST', '127.0.0.1')
    port = int(os.environ.get('PORT', '8000'))
    server = ThreadingHTTPServer((host, port), JoglumeHandler)
    print(f'Joglume disponível em http://{host}:{port}')
    print('Capas automáticas: Libretro + Google Imagens.')
    print('PSP e PS2 habilitados com isolamento de origem cruzada.')
    if host in ('127.0.0.1', 'localhost'):
        threading.Timer(0.8, lambda: webbrowser.open(f'http://localhost:{port}')).start()
    server.serve_forever()
