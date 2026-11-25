import os
import re
import json
import time
import base64
import unicodedata
import requests
import xml.etree.ElementTree as ET
from urllib.parse import urlparse
from concurrent.futures import ThreadPoolExecutor, as_completed

OWNER = "JOGLUME"
REPO = "JOGLUME"
BRANCH = "main"
TOKEN = os.environ["GITHUB_TOKEN"]
API = f"https://api.github.com/repos/{OWNER}/{REPO}"
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "Joglume-CoverCollector/1.0.2"})
SOURCES = [
    ("CoolDude2349/Offline-HTML-Games-Pack", "master", "offline/"),
    ("AmmarSAA/flash-games-directory", "main", ""),
]

def norm(value):
    value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode().lower()
    value = re.sub(r"\.(html?|swf)$", "", value)
    value = re.sub(r"[^a-z0-9]+", "-", value).strip("-")
    return value

def get_json(url, headers=None):
    r = SESSION.get(url, headers=headers, timeout=30)
    r.raise_for_status()
    return r.json()

def source_games():
    found = {}
    for repo, ref, prefix in SOURCES:
        tree = get_json(f"https://api.github.com/repos/{repo}/git/trees/{ref}?recursive=1")
        for item in tree.get("tree", []):
            path = item.get("path", "")
            if item.get("type") != "blob":
                continue
            low = path.lower()
            if prefix:
                if not low.startswith(prefix) or not low.endswith((".html", ".htm")):
                    continue
            else:
                if "/" in path or not low.endswith(".swf"):
                    continue
            raw = path.rsplit("/", 1)[-1]
            title = re.sub(r"\.(html?|swf)$", "", raw, flags=re.I)
            title = re.sub(r"[-_]+", " ", title)
            title = re.sub(r"\b(www|com|net)\b", " ", title, flags=re.I)
            title = re.sub(r"\s+", " ", title).strip(" ._-")
            slug = norm(title)
            if len(slug) < 2 or slug in {"index", "player", "ruffle"}:
                continue
            found.setdefault(slug, title)
    return found

def sitemap_urls(root, markers):
    pending = [root]
    urls = set()
    seen = set()
    while pending and len(seen) < 150:
        current = pending.pop()
        if current in seen:
            continue
        seen.add(current)
        try:
            r = SESSION.get(current, timeout=35)
            r.raise_for_status()
            content = r.content
            if current.lower().endswith(".gz") or r.headers.get("Content-Type", "").lower() in {"application/gzip", "application/x-gzip"}:
                import gzip
                content = gzip.decompress(content)
            doc = ET.fromstring(content)
            locs = [node.text.strip() for node in doc.iter() if node.tag.endswith("loc") and node.text]
            sitemap_locs = [x for x in locs if re.search(r"\\.(xml|xml\\.gz)(?:$|\\?)", urlparse(x).path, re.I)]
            if sitemap_locs:
                pending.extend(sitemap_locs)
            else:
                urls.update(x for x in locs if any(marker in urlparse(x).path.lower() for marker in markers))
        except Exception as exc:
            print(f"Sitemap ignorado: {current}: {exc}")
    return urls

def discover_catalog_urls():
    catalogs = [
        ("poki.com", ["/g/"], ["https://poki.com/br/sitemaps/index.xml"]),
        ("crazygames.com", ["/game/"], ["https://www.crazygames.com/sitemap-index.xml"]),
        ("y8.com", ["/games/", "/game/"], ["https://www.y8.com/sitemap.xml", "https://www.y8.com/sitemap_index.xml"]),
        ("lagged.com", ["/game/", "/games/", "/en/g/"], ["https://lagged.com/sitemap.xml", "https://lagged.com/sitemap_index.xml"]),
        ("hackedfreegames.com", ["/game/"], ["https://www.hackedfreegames.com/sitemap.xml", "https://www.hackedfreegames.com/sitemap_index.xml"]),
        ("gamedistribution.com", ["/game/"], ["https://gamedistribution.com/sitemap.xml", "https://gamedistribution.com/sitemap_index.xml"]),
        ("gamemonetize.com", ["/game/"], ["https://gamemonetize.com/sitemap.xml", "https://gamemonetize.com/sitemap_index.xml"]),
        ("friv.com", ["/"], ["https://www.friv.com/sitemap.xml"]),
        ("kongregate.com", ["/games/"], ["https://www.kongregate.com/sitemap.xml"]),
        ("armorgames.com", ["/play/"], ["https://armorgames.com/sitemap.xml", "https://armorgames.com/sitemap_index.xml"]),
        ("newgrounds.com", ["/portal/view/"], ["https://www.newgrounds.com/sitemap.xml"]),
        ("miniplay.com", ["/game/"], ["https://www.miniplay.com/sitemap.xml", "https://www.miniplay.com/sitemap_index.xml"]),
    ]
    discovered = []
    for domain, markers, fallbacks in catalogs:
        roots = []
        try:
            robots = SESSION.get(f"https://{domain}/robots.txt", timeout=20)
            if robots.status_code == 200:
                roots.extend(re.findall(r"(?im)^\\s*Sitemap:\\s*(https?://\\S+)", robots.text))
        except Exception:
            pass
        roots.extend(fallbacks)
        unique_roots = list(dict.fromkeys(roots))
        domain_urls = set()
        for root in unique_roots:
            domain_urls.update(sitemap_urls(root, markers))
            if len(domain_urls) >= 50000:
                break
        print(f"{domain}: {len(domain_urls)} páginas de catálogo")
        discovered.extend(domain_urls)
    return set(discovered)

def image_from_page(url):
    try:
        r = SESSION.get(url, timeout=25)
        if r.status_code != 200:
            return None
        html = r.text
        patterns = [
            r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']',
            r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image["\']',
            r'<meta[^>]+name=["\']twitter:image["\'][^>]+content=["\']([^"\']+)["\']',
        ]
        image = None
        for pattern in patterns:
            m = re.search(pattern, html, re.I)
            if m:
                image = m.group(1).replace("&amp;", "&")
                break
        if not image or not image.startswith("https://"):
            return None
        check = SESSION.get(image, stream=True, timeout=20)
        content_type = check.headers.get("Content-Type", "").lower()
        size = int(check.headers.get("Content-Length", "0") or 0)
        check.close()
        if check.status_code != 200 or not content_type.startswith("image/") or (size and size < 1500):
            return None
        return image
    except Exception:
        return None

def github_file(path):
    r = requests.get(f"{API}/contents/{path}", headers=HEADERS, params={"ref": BRANCH}, timeout=30)
    r.raise_for_status()
    data = r.json()
    content = base64.b64decode(data["content"]).decode("utf-8")
    return content, data["sha"]

def put_file(path, content, sha, message):
    payload = {"message": message, "content": base64.b64encode(content.encode()).decode(), "branch": BRANCH, "sha": sha}
    r = requests.put(f"{API}/contents/{path}", headers=HEADERS, json=payload, timeout=40)
    r.raise_for_status()
    return r.json()

def main():
    games = source_games()
    print(f"Jogos únicos encontrados: {len(games)}")
    sitemap = discover_catalog_urls()
    by_slug = {}
    for url in sorted(sitemap, key=lambda x: 0 if "poki.com" in x else 1):
        slug = norm(urlparse(url).path.rsplit("/", 1)[-1])
        if slug:
            by_slug.setdefault(slug, url)
    matches = [(slug, title, by_slug[slug]) for slug, title in games.items() if slug in by_slug]
    print(f"Correspondências exatas em todos os catálogos: {len(matches)}")
    results = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        jobs = {pool.submit(image_from_page, url): (slug, title) for slug, title, url in matches}
        for future in as_completed(jobs):
            slug, title = jobs[future]
            image = future.result()
            if image:
                results[slug] = (title, image)
    old, sha = github_file("capas/capa.txt")
    entries = {}
    for line in old.splitlines():
        if ":" in line:
            name, url = line.split(":", 1)
            if url.strip().startswith("https://"):
                entries[norm(name)] = (name.strip(), url.strip())
    added = 0
    for slug, (title, image) in results.items():
        if slug not in entries or "jogos360.com.br" in entries[slug][1].lower():
            entries[slug] = (title, image)
            added += 1
    new_content = "\n".join(f"{name}: {url}" for name, url in sorted(entries.values(), key=lambda x: x[0].lower())) + "\n"
    if added:
        put_file("capas/capa.txt", new_content, sha, f"Add {added} automatically verified game covers")
    pending = sorted(title for slug, title in games.items() if slug not in entries)
    try:
        old_pending, pending_sha = github_file("capas/sem-capa.txt")
    except Exception:
        old_pending, pending_sha = "", None
    pending_content = "# Jogos ainda sem capa verificada\n" + "\n".join(pending) + "\n"
    if pending_content != old_pending:
        if pending_sha:
            put_file("capas/sem-capa.txt", pending_content, pending_sha, "Update games without verified covers")
        else:
            payload = {"message": "Add list of games without verified covers", "content": base64.b64encode(pending_content.encode()).decode(), "branch": BRANCH}
            requests.put(f"{API}/contents/capas/sem-capa.txt", headers=HEADERS, json=payload, timeout=40).raise_for_status()
    print(json.dumps({"games": len(games), "catalog_urls": len(sitemap), "exact_matches": len(matches), "verified_images": len(results), "new_covers": added, "without_cover": len(pending)}, ensure_ascii=False))

if __name__ == "__main__":
    main()
