"use strict";

const CONFIG = {
    ruffleCDN: "https://unpkg.com/@ruffle-rs/ruffle",
    emulatorData: "https://cdn.emulatorjs.org/stable/data/",
    githubAPI: "https://api.github.com/repos/",
    maxGamesPerSource: 1200,
    maxFileSize: 100 * 1024 * 1024,
    autoUpdateInterval: 6 * 60 * 60 * 1000
};

const DIRECTORIES = [
    {
        id: "gba-roms",
        name: "Game Boy Advance ROMs",
        owner: "CleberDevOps",
        repo: "roms-gameboy-advanced",
        branch: "master",
        category: "rpg",
        platform: "gba",
        origin: "native"
    },
    {
        id: "offline-html-games",
        name: "Offline HTML Games Pack",
        owner: "CoolDude2349",
        repo: "Offline-HTML-Games-Pack",
        branch: "master",
        category: "acao",
        platform: "html5",
        origin: "native"
    },
    {
        id: "flash-games-directory",
        name: "Flash Games Directory",
        owner: "AmmarSAA",
        repo: "flash-games-directory",
        branch: "main",
        category: "acao",
        platform: "flash",
        origin: "native"
    },
    {
        id: "snes-dolchi21",
        name: "SNES ROMs · Dolchi21",
        owner: "dolchi21-retroarch",
        repo: "snes-roms",
        branch: "master",
        category: "auto",
        platform: "snes",
        extensions: ["7z", "zip"],
        required: true,
        origin: "native"
    },
    {
        id: "snes-coop",
        name: "SNES Co-op Retro Games",
        owner: "hacan359",
        repo: "co-op-retro-games",
        branch: "main",
        path: "roms/snes",
        url: "https://github.com/hacan359/co-op-retro-games/tree/main/roms/snes",
        category: "auto",
        platform: "snes",
        extensions: ["zip", "7z", "sfc", "smc"],
        required: true,
        origin: "native"
    },
    {
        id: "megadrive-homebrew",
        name: "Mega Drive Homebrew · RetroBrews",
        owner: "retrobrews",
        repo: "md-games",
        branch: "",
        category: "auto",
        platform: "segaMD",
        extensions: ["bin"],
        required: true,
        origin: "native"
    }
];

const CATEGORY_NAMES = {
    "mundo-aberto": "Mundo aberto",
    luta: "Luta",
    acao: "Ação",
    futebol: "Futebol",
    esportes: "Esportes",
    aventura: "Aventura",
    rpg: "RPG",
    corrida: "Corrida",
    outros: "Outros"
};

const CATEGORY_ICONS = {
    "mundo-aberto": "🌍",
    luta: "🥊",
    acao: "⚔️",
    futebol: "⚽",
    esportes: "🏆",
    aventura: "🗺️",
    rpg: "🛡️",
    corrida: "🏎️",
    outros: "🎮"
};

const PLATFORM_INFO = {
    flash: { label: "FLASH", extension: ["swf"], icon: "🎮" },
    html5: { label: "HTML5", extension: ["html", "htm"], icon: "🌐" },
    gba: { label: "GBA", extension: ["gba"], icon: "🎮" },
    gbc: { label: "GBC", extension: ["gbc"], icon: "🎮" },
    gb: { label: "GB", extension: ["gb"], icon: "🎮" },
    nes: { label: "NES", extension: ["nes"], icon: "🎮" },
    snes: { label: "SNES", extension: ["sfc", "smc"], icon: "🎮" },
    nds: { label: "NDS", extension: ["nds"], icon: "🎮" },
    n64: { label: "N64", extension: ["z64", "n64", "v64"], icon: "🎮" },
    segaMD: { label: "MEGA DRIVE", extension: ["md", "gen", "bin"], icon: "🎮" },
    psx: { label: "PS1", extension: ["iso", "cue", "bin"], icon: "🎮" },
    arcade: { label: "ARCADE", extension: ["zip"], icon: "🕹️" },
    psp: { label: "PSP", extension: ["iso", "cso"], icon: "🎮" }
};

const EMULATOR_CORES = {
    gba: "gba",
    gbc: "gbc",
    gb: "gb",
    nes: "nes",
    snes: "snes",
    nds: "nds",
    n64: "n64",
    segaMD: "segaMD",
    psx: "psx",
    arcade: "arcade",
    psp: "psp"
};

const STORAGE_KEYS = {
    sources: "fm_sources_v3",
    games: "fm_games_v3",
    favorites: "fm_favorites",
    recent: "fm_recent",
    lastUpdate: "fm_last_source_update"
};

const COVER_CONFIG = {
    baseURL: "https://thumbnails.libretro.com/",
    systems: {
        gba: "Nintendo - Game Boy Advance",
        gbc: "Nintendo - Game Boy Color",
        gb: "Nintendo - Game Boy",
        nes: "Nintendo - Nintendo Entertainment System",
        snes: "Nintendo - Super Nintendo Entertainment System",
        nds: "Nintendo - Nintendo DS",
        n64: "Nintendo - Nintendo 64",
        segaMD: "Sega - Mega Drive - Genesis",
        psx: "Sony - PlayStation",
        psp: "Sony - PlayStation Portable",
        arcade: "MAME"
    },
    cacheKey: "joglume_cover_matches_v7"
};

const coverMatches = (() => {
    try { return JSON.parse(localStorage.getItem(COVER_CONFIG.cacheKey) || "{}"); }
    catch { return {}; }
})();
const coverIndexes = new Map();
const coverPending = new Map();
let coverObserver = null;
const coverGamesById = new Map();

function normalizeCoverName(value) {
    return String(value || "")
        .replace(/\.[^.]+$/, "")
        .replace(/\s*\([^)]*\)/g, " ")
        .replace(/\[[^\]]*\]/g, " ")
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim().replace(/\s+/g, " ");
}

function getCoverSystem(type) {
    return COVER_CONFIG.systems[type] || null;
}

function getCoverIndex(system) {
    if (coverIndexes.has(system)) return coverIndexes.get(system);

    const promise = (async () => {
        const repository = system.replace(/\s+/g, "_");
        const apiURL = `https://api.github.com/repos/libretro-thumbnails/${encodeURIComponent(repository)}/git/trees/master?recursive=1`;
        const response = await fetch(apiURL, {
            headers: { Accept: "application/vnd.github+json" },
            cache: "force-cache"
        });
        if (!response.ok) throw new Error("Índice do GitHub indisponível");
        const tree = await response.json();
        if (!Array.isArray(tree.tree) || tree.truncated) throw new Error("Índice incompleto");
        const filenames = tree.tree
            .filter(entry => entry.type === "blob" && entry.path.startsWith("Named_Boxarts/") && entry.path.toLowerCase().endsWith(".png"))
            .map(entry => entry.path.slice("Named_Boxarts/".length));
        if (!filenames.length) throw new Error("Nenhuma capa encontrada para este console");
        return filenames;
    })();

    coverIndexes.set(system, promise);
    promise.catch(() => coverIndexes.delete(system));
    return promise;
}

function findBestCover(game, filenames) {
    const target = normalizeCoverName(game.name);
    if (!target) return null;

    let best = null;
    let bestScore = 0;
    let secondScore = 0;
    const seenTitles = new Set();
    const targetWords = target.split(" ").filter(word => word.length > 1);

    for (const filename of filenames) {
        const candidate = normalizeCoverName(filename);
        if (!candidate || seenTitles.has(candidate)) continue;
        seenTitles.add(candidate);

        const candidateWords = candidate.split(" ").filter(word => word.length > 1);
        if (!candidateWords.length) continue;

        let score = 0;
        if (candidate === target) score = 1;
        else if (targetWords.every(word => candidateWords.includes(word)) && candidateWords.length <= targetWords.length + 2) {
            score = 0.91;
        } else if (candidateWords.every(word => targetWords.includes(word)) && candidateWords.length >= 2) {
            score = 0.9;
        } else {
            const overlap = targetWords.filter(word => candidateWords.includes(word)).length;
            const precision = overlap / targetWords.length;
            const recall = overlap / candidateWords.length;
            score = (2 * precision * recall) / (precision + recall || 1);
            if (precision < 1) score *= precision;
        }

        if (score > bestScore) {
            secondScore = bestScore;
            bestScore = score;
            best = filename;
        } else if (score > secondScore) {
            secondScore = score;
        }
    }

    return bestScore >= 0.88 && (bestScore === 1 || bestScore - secondScore >= 0.06) ? best : null;
}

function saveCoverMatches() {
    try { localStorage.setItem(COVER_CONFIG.cacheKey, JSON.stringify(coverMatches)); }
    catch { }
}

function coverFallback(cover) {
    const placeholder = cover.querySelector(".game-cover-placeholder");
    const image = cover.querySelector("img");
    if (image) image.remove();
    if (placeholder) {
        placeholder.hidden = false;
        placeholder.innerHTML = '<small>Capa não encontrada</small>';
    }
    cover.classList.remove("has-cover");
}

async function getManualCover(game) {
    const response = await fetch("/api/covers?q=" + encodeURIComponent(game.name || ""), {
        headers: { Accept: "application/json" },
        cache: "no-store"
    });
    if (!response.ok) throw new Error("Lista manual de capas indisponível");
    const data = await response.json();
    return data.image || null;
}

async function loadGameCover(game, cover, skipCache = false) {
    if (!game || !cover || cover.dataset.coverLoaded === "true") return;
    cover.dataset.coverLoaded = "true";

    const placeholder = cover.querySelector(".game-cover-placeholder");

    const showImage = candidate => new Promise(resolve => {
        const url = typeof candidate === "string" ? candidate : candidate?.url;
        if (!url || !/^https?:\/\//i.test(url)) return resolve(false);
        const image = document.createElement("img");
        image.alt = "Capa de " + game.name;
        image.loading = "lazy";
        image.decoding = "async";
        image.referrerPolicy = "strict-origin-when-cross-origin";
        image.onload = () => {
            if (placeholder) placeholder.hidden = true;
            cover.classList.add("has-cover");
            resolve(true);
        };
        image.onerror = () => {
            image.remove();
            resolve(false);
        };
        image.src = url;
        cover.insertBefore(image, placeholder);
    });

    try {
        const candidate = await getManualCover(game);
        if (candidate && await showImage(candidate)) {
            game.coverUrl = candidate.url;
            return;
        }
    } catch {
    }

    coverFallback(cover);
    cover.dataset.coverLoaded = "false";
}

function hydrateGameCovers(container, list) {
    if (!container || !list?.length) return;
    list.forEach(game => coverGamesById.set(String(game.id), game));
    const cards = container.querySelectorAll(".game-card[data-game-id]");
    if ("IntersectionObserver" in window && !coverObserver) {
        coverObserver = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                coverObserver.unobserve(entry.target);
                const game = coverGamesById.get(entry.target.closest(".game-card")?.dataset.gameId);
                if (game) loadGameCover(game, entry.target);
            });
        }, { rootMargin: "250px" });
    }
    cards.forEach(card => {
        const cover = card.querySelector(".game-cover");
        if (!cover) return;
        if (coverObserver) coverObserver.observe(cover);
        else {
            const game = coverGamesById.get(card.dataset.gameId);
            if (game) loadGameCover(game, cover);
        }
    });
}

let games = [];
let sources = [];
let favorites = JSON.parse(localStorage.getItem(STORAGE_KEYS.favorites) || "[]");
let recentGames = JSON.parse(localStorage.getItem(STORAGE_KEYS.recent) || "[]");
let currentGame = null;
let currentCategory = "todos";
let currentFilter = "todos";
let currentSourceFilter = "todos";
let selectedFile = null;
let selectedConsole = "gba";
let currentObjectURL = null;
let db = null;
let sourceUpdateRunning = false;

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
    })[char]);
}

function saveFavorites() {
    localStorage.setItem(STORAGE_KEYS.favorites, JSON.stringify(favorites));
}

function saveRecent() {
    localStorage.setItem(STORAGE_KEYS.recent, JSON.stringify(recentGames));
}

function saveGames() {
    const persistentGames = games
        .filter(game => !game.local)
        .map(game => ({
            ...game,
            url: game.url
        }));

    localStorage.setItem(STORAGE_KEYS.games, JSON.stringify(persistentGames));
}

function saveSources() {
    localStorage.setItem(STORAGE_KEYS.sources, JSON.stringify(sources));
}

function showToast(message, type = "success") {
    const container = $("#toast-container");
    if (!container) return;

    const toast = document.createElement("div");
    toast.className = "toast" + (type === "error" ? " error" : "");
    toast.textContent = message;

    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
}

function normalizeName(name) {
    return String(name || "")
        .replace(/\.[^.]+$/, "")
        .replace(/[_-]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\b\w/g, letter => letter.toUpperCase());
}

function guessCategory(name) {
    const value = String(name || "").toLowerCase();

    if (/soccer|football|futebol|penalty|goal|world cup|champion|kick|basketball/.test(value)) {
        return "futebol";
    }

    if (/boxing|wrestling|fighter|fighting|smash|combat|brawl|street fighter|mortal kombat|super fighters/.test(value)) {
        return "luta";
    }

    if (/racing|race|kart|drift|car|bike|motor|rally/.test(value)) {
        return "corrida";
    }

    if (/rpg|quest|dungeon|warrior|sword|knight|adventure|zelda/.test(value)) {
        return "aventura";
    }

    if (/minecraft|sandbox|world|open world|exploration|explore|motherload|stick rpg/.test(value)) {
        return "mundo-aberto";
    }

    if (/sport|tennis|golf|skate|snowboard|surf|olympic|bowling|baseball/.test(value)) {
        return "esportes";
    }

    if (/sonic|mario|platform|run|action|ninja|shooter|shoot|gun|war|zombie|defense/.test(value)) {
        return "acao";
    }

    return "outros";
}

function detectPlatformFromPath(path) {
    const extension = String(path).split(".").pop().toLowerCase();

    for (const [platform, info] of Object.entries(PLATFORM_INFO)) {
        if (info.extension.includes(extension)) {
            return platform;
        }
    }

    return null;
}

function getPlatformLabel(type) {
    return PLATFORM_INFO[type]?.label || String(type || "JOGO").toUpperCase();
}

function getPlatformIcon(type) {
    return PLATFORM_INFO[type]?.icon || "🎮";
}

function getGameOrigin(game) {
    if (game.local) return "local";
    return game.origin || (game.sourceId ? "github" : "url");
}

function addGame(game) {
    if (!game || !game.url || !game.name) return false;

    const existing = games.find(item =>
        item.url === game.url ||
        (game.sourceId && item.sourceId === game.sourceId && item.path === game.path)
    );

    if (existing) {
        Object.assign(existing, {
            name: game.name,
            category: game.category || existing.category,
            type: game.type || existing.type,
            source: game.source || existing.source,
            origin: game.origin || existing.origin,
            sourceId: game.sourceId || existing.sourceId,
            path: game.path || existing.path
        });

        return false;
    }

    games.push({
        id: game.id || crypto.randomUUID(),
        name: game.name,
        url: game.url,
        type: game.type || "flash",
        category: game.category || "outros",
        source: game.source || "personalizado",
        sourceId: game.sourceId || null,
        path: game.path || null,
        origin: game.origin || (game.local ? "local" : "url"),
        icon: "",
        local: Boolean(game.local),
        fileId: game.fileId || null,
        addedAt: game.addedAt || Date.now()
    });

    return true;
}

function removeSourceGames(sourceId) {
    const removedIds = games
        .filter(game => game.sourceId === sourceId)
        .map(game => game.id);

    games = games.filter(game => game.sourceId !== sourceId);
    favorites = favorites.filter(id => !removedIds.includes(id));
    recentGames = recentGames.filter(id => !removedIds.includes(id));

    saveFavorites();
    saveRecent();
    saveGames();
}

function getInitialSources() {
    return DIRECTORIES.map(directory => ({
        ...directory,
        url: directory.url || `https://github.com/${directory.owner}/${directory.repo}`,
        enabled: true,
        autoUpdate: true,
        recursive: true,
        custom: false,
        lastUpdated: 0,
        gameCount: 0,
        status: "pending"
    }));
}

function loadSavedSources() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.sources) || "null");

        if (!Array.isArray(saved)) {
            sources = getInitialSources();
            saveSources();
            return;
        }

        const savedById = new Map(saved.map(source => [source.id, source]));

        sources = getInitialSources().map(initial => ({
            ...initial,
            ...(savedById.get(initial.id) || {})
        }));

        saved.forEach(source => {
            if (source.custom && !sources.some(item => item.id === source.id)) {
                sources.push(source);
            }
        });
        sources.forEach(source => { if (source.required) source.enabled = true; });

        saveSources();
    } catch {
        sources = getInitialSources();
        saveSources();
    }
}

function loadSavedGames() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.games) || "[]");

        if (Array.isArray(saved)) {
            saved.forEach(game => addGame(game));
        }
    } catch {
        localStorage.removeItem(STORAGE_KEYS.games);
    }
}

/* INDEXED DB */

function openDatabase() {
    return new Promise((resolve, reject) => {
        if (!window.indexedDB) {
            resolve(null);
            return;
        }

        const request = indexedDB.open("FlashManiaDatabase", 2);

        request.onupgradeneeded = event => {
            const database = event.target.result;

            if (!database.objectStoreNames.contains("games")) {
                database.createObjectStore("games", {
                    keyPath: "id"
                });
            }
        };

        request.onsuccess = () => {
            db = request.result;
            resolve(db);
        };

        request.onerror = () => reject(request.error);
    });
}

function databaseAction(storeName, mode, callback) {
    return new Promise((resolve, reject) => {
        if (!db) {
            reject(new Error("Banco de dados indisponível."));
            return;
        }

        const transaction = db.transaction(storeName, mode);
        const store = transaction.objectStore(storeName);
        const request = callback(store);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function saveLocalGame(game, file) {
    if (!db) {
        throw new Error("Banco de dados indisponível.");
    }

    await databaseAction("games", "readwrite", store => {
        return store.put({
            id: game.id,
            name: game.name,
            type: game.type,
            category: game.category,
            file: file
        });
    });
}

async function restoreLocalGames() {
    if (!db) return;

    const stored = await databaseAction(
        "games",
        "readonly",
        store => store.getAll()
    );

    for (const item of stored || []) {
        const existing = games.find(game => game.id === item.id);

        if (existing) continue;

        const url = URL.createObjectURL(item.file);

        addGame({
            id: item.id,
            name: item.name,
            url,
            type: item.type,
            category: item.category,
            source: "Arquivo local",
            origin: "local",
            local: true,
            fileId: item.id
        });
    }
}

/* GITHUB */

function parseGitHubURL(value) {
    const url = new URL(value);

    if (url.hostname !== "github.com") {
        throw new Error("Adicione um endereço válido do GitHub.");
    }

    const parts = url.pathname.split("/").filter(Boolean);

    if (parts.length < 2) {
        throw new Error("O endereço precisa conter usuário e repositório.");
    }

    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, "");
    let branch = "";
    let path = "";

    if (parts[2] === "tree" || parts[2] === "blob") {
        branch = parts[3] || "";
        path = parts.slice(4).join("/");
    }

    return { owner, repo, branch, path };
}

async function githubFetch(url) {
    const response = await fetch(url, {
        headers: {
            Accept: "application/vnd.github+json"
        }
    });

    if (response.status === 403 || response.status === 429) {
        throw new Error("Limite de requisições do GitHub atingido. Tente novamente mais tarde.");
    }

    if (!response.ok) {
        throw new Error(`Erro do GitHub (${response.status}). Verifique se o repositório é público.`);
    }

    return response.json();
}

function buildRawURL(owner, repo, branch, path) {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    return `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${encodedPath}`;
}

function buildHTMLGameURL(owner, repo, branch, path) {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    return `https://raw.githack.com/${owner}/${repo}/${encodeURIComponent(branch)}/${encodedPath}`;
}

function isSupportedGameFile(path) {
    return Boolean(detectPlatformFromPath(path));
}

async function getRepositoryFiles(owner, repo, branch, directoryPath, recursive) {
    const base = `${CONFIG.githubAPI}${owner}/${repo}`;
    const treeURL = `${base}/git/trees/${encodeURIComponent(branch)}?recursive=1`;

    const treeData = await githubFetch(treeURL);

    if (!treeData.truncated) {
        return (treeData.tree || [])
            .filter(item => item.type === "blob")
            .map(item => item.path)
            .filter(path => {
                if (directoryPath && !path.startsWith(directoryPath.replace(/\/?$/, "/")) && path !== directoryPath) {
                    return false;
                }

                if (!recursive && directoryPath) {
                    const relative = path.slice(directoryPath.length).replace(/^\/+/, "");
                    return !relative.includes("/");
                }

                return true;
            });
    }

    return getFilesByContents(owner, repo, branch, directoryPath, recursive);
}

async function getFilesByContents(owner, repo, branch, directoryPath, recursive) {
    const result = [];
    const queue = [directoryPath || ""];

    while (queue.length && result.length < 10000) {
        const currentPath = queue.shift();
        const endpoint = `${CONFIG.githubAPI}${owner}/${repo}/contents/${currentPath.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`;
        const entries = await githubFetch(endpoint);

        if (!Array.isArray(entries)) continue;

        for (const entry of entries) {
            if (entry.type === "file") {
                result.push(entry.path);
            } else if (entry.type === "dir" && recursive) {
                queue.push(entry.path);
            }
        }
    }

    return result;
}

function updateDirectoryStatus(source, text, color) {
    const card = document.querySelector(`[data-directory="${source.id}"]`);
    const status = card?.querySelector(".directory-status");

    if (status) {
        status.textContent = text;
        if (color) status.style.color = color;
    }
}

function updateSourceProgress(text, count, percent) {
    const progress = $("#source-progress");
    if (!progress) return;

    progress.hidden = false;
    progress.classList.remove("hidden");

    if ($("#source-progress-text")) {
        $("#source-progress-text").textContent = text;
    }

    if ($("#source-progress-count")) {
        $("#source-progress-count").textContent = count;
    }

    if ($("#source-progress-bar")) {
        $("#source-progress-bar").style.width = `${Math.max(0, Math.min(100, percent))}%`;
    }
}

function hideSourceProgress() {
    const progress = $("#source-progress");
    if (progress) {
        progress.hidden = true;
        progress.classList.add("hidden");
    }
}

async function loadDirectory(source, options = {}) {
    if (!source.enabled && !options.force) return 0;

    updateDirectoryStatus(source, "Carregando...", "#ffb347");

    try {
        const repositoryURL = `${CONFIG.githubAPI}${source.owner}/${source.repo}`;
        const repoInfo = await githubFetch(repositoryURL);
        const branch = source.branch || repoInfo.default_branch;

        const files = await getRepositoryFiles(
            source.owner,
            source.repo,
            branch,
            source.path || "",
            source.recursive !== false
        );

        const supportedFiles = files
            .filter(path => {
                const extension = String(path).split(".").pop().toLowerCase();
                if (Array.isArray(source.extensions) && source.extensions.length) return source.extensions.includes(extension);
                if (source.platform && source.platform !== "auto") {
                    return (PLATFORM_INFO[source.platform]?.extension || []).includes(extension);
                }
                return isSupportedGameFile(path);
            })
            .filter(path => !/(^|\/)(node_modules|vendor|dist|build|\.git)(\/|$)/i.test(path))
            .filter(path => !/(^|\/)(readme|license|changelog|contributing)\.(html?|md)$/i.test(path))
            .slice(0, CONFIG.maxGamesPerSource);

        let added = 0;
        let updated = 0;

        for (let index = 0; index < supportedFiles.length; index++) {
            const path = supportedFiles[index];
            const filename = path.split("/").pop();
            const name = normalizeName(filename);
            const detectedType = detectPlatformFromPath(path);
            const type = source.platform && source.platform !== "auto"
                ? source.platform
                : detectedType;

            if (!PLATFORM_INFO[type]) continue;

            const url = type === "html5"
                ? buildHTMLGameURL(source.owner, source.repo, branch, path)
                : buildRawURL(source.owner, source.repo, branch, path);

            const category = source.category && source.category !== "auto"
                ? source.category
                : guessCategory(name);

            const alreadyExists = games.some(game =>
                game.sourceId === source.id && game.path === path
            );

            const wasAdded = addGame({
                id: `${source.id}-${path}`,
                name,
                url,
                type,
                category,
                source: source.name,
                sourceId: source.id,
                path,
                origin: source.custom ? "github" : "native",
                icon: getPlatformIcon(type)
            });

            if (wasAdded) added++;
            else if (alreadyExists) updated++;

            if (index % 20 === 0) {
                updateSourceProgress(
                    `Importando ${source.name}`,
                    `${index + 1}/${supportedFiles.length}`,
                    supportedFiles.length ? ((index + 1) / supportedFiles.length) * 100 : 100
                );
            }
        }

        source.branch = branch;
        source.gameCount = supportedFiles.length;
        source.lastUpdated = Date.now();
        source.status = "active";
        source.lastError = "";

        updateDirectoryStatus(
            source,
            `${supportedFiles.length} jogos`,
            "#58d69a"
        );

        saveSources();
        saveGames();
        renderAll();
        renderSourceManager();

        return added;

    } catch (error) {
        console.error(source.name, error);

        source.status = "error";
        source.lastError = error.message;

        updateDirectoryStatus(source, "Indisponível", "#ff5368");

        saveSources();
        renderSourceManager();

        if (options.showError) {
            showToast(`${source.name}: ${error.message}`, "error");
        }

        return 0;
    }
}

async function loadAllDirectories() {
    if (sourceUpdateRunning) return;

    sourceUpdateRunning = true;

    const enabledSources = sources.filter(source => source.enabled);

    let total = 0;

    try {
        for (let index = 0; index < enabledSources.length; index++) {
            const source = enabledSources[index];

            updateSourceProgress(
                `Atualizando ${source.name}`,
                `${index + 1}/${enabledSources.length}`,
                enabledSources.length ? (index / enabledSources.length) * 100 : 100
            );

            total += await loadDirectory(source);
        }

        localStorage.setItem(STORAGE_KEYS.lastUpdate, String(Date.now()));

        updateSourceProgress("Atualização concluída", `${enabledSources.length} fontes`, 100);

        if (enabledSources.length) {
            showToast(`${total} jogos novos encontrados nas fontes.`);
        }

        renderAll();
        renderSourceManager();

    } finally {
        sourceUpdateRunning = false;
        setTimeout(hideSourceProgress, 1800);
    }
}

async function refreshSource(sourceId) {
    const source = sources.find(item => item.id === sourceId);
    if (!source) return;

    updateSourceProgress(`Atualizando ${source.name}`, "Iniciando...", 5);

    const added = await loadDirectory(source, {
        force: true,
        showError: true
    });

    updateSourceProgress("Atualização concluída", `${added} jogos novos`, 100);
    setTimeout(hideSourceProgress, 1800);
}

function addGitHubSource(event) {
    event.preventDefault();

    const url = $("#source-url")?.value.trim();
    if (!url) return;

    try {
        const parsed = parseGitHubURL(url);

        const duplicate = sources.find(source =>
            source.owner.toLowerCase() === parsed.owner.toLowerCase() &&
            source.repo.toLowerCase() === parsed.repo.toLowerCase() &&
            (source.path || "") === parsed.path
        );

        if (duplicate) {
            showToast("Essa fonte já está cadastrada.", "error");
            return;
        }

        const platform = $("#source-platform")?.value || "auto";
        const category = $("#source-category")?.value || "auto";
        const sourceName = $("#source-name")?.value.trim();

        const source = {
            id: `custom-${crypto.randomUUID()}`,
            name: sourceName || `${parsed.owner}/${parsed.repo}`,
            owner: parsed.owner,
            repo: parsed.repo,
            branch: $("#source-branch")?.value.trim() || parsed.branch || "",
            path: parsed.path,
            url,
            platform,
            category,
            enabled: true,
            autoUpdate: $("#source-auto-update")?.checked ?? true,
            recursive: $("#source-recursive")?.checked ?? true,
            custom: true,
            origin: "github",
            lastUpdated: 0,
            gameCount: 0,
            status: "pending"
        };

        sources.push(source);
        saveSources();

        $("#add-source-form").reset();

        if ($("#source-auto-update")) $("#source-auto-update").checked = true;
        if ($("#source-recursive")) $("#source-recursive").checked = true;

        renderSourceManager();
        showToast("Fonte adicionada. Iniciando importação...");

        refreshSource(source.id);

    } catch (error) {
        showToast(error.message || "URL do GitHub inválida.", "error");
    }
}

function toggleSource(sourceId) {
    const source = sources.find(item => item.id === sourceId);
    if (!source) return;
    if (source.required) {
        showToast("Esta fonte é obrigatória e não pode ser desativada.", "error");
        return;
    }

    source.enabled = !source.enabled;

    saveSources();
    renderSourceManager();

    if (source.enabled) {
        refreshSource(sourceId);
    } else {
        showToast("Fonte desativada.");
    }
}

function deleteSource(sourceId) {
    const source = sources.find(item => item.id === sourceId);
    if (!source || !source.custom) {
        showToast("As fontes originais não podem ser removidas. Você pode desativá-las.", "error");
        return;
    }

    sources = sources.filter(item => item.id !== sourceId);
    removeSourceGames(sourceId);
    saveSources();
    renderSourceManager();
    renderAll();

    showToast("Fonte removida da biblioteca.");
}

function renderSourceManager() {
    const list = $("#source-list");

    if ($("#total-sources")) {
        $("#total-sources").textContent = sources.length;
    }

    if ($("#total-imported-games")) {
        $("#total-imported-games").textContent = games.filter(game =>
            game.origin === "github" || game.origin === "native"
        ).length;
    }

    if ($("#active-sources")) {
        $("#active-sources").textContent = sources.filter(source => source.enabled).length;
    }

    if (!list) return;

    if (!sources.length) {
        list.innerHTML = `<div class="empty-state">Nenhuma fonte cadastrada.</div>`;
        return;
    }

    list.innerHTML = sources.map(source => {
        const statusClass = source.status === "error"
            ? "error"
            : source.enabled ? "" : "disabled";

        const statusText = source.status === "error"
            ? "Erro"
            : source.enabled ? "Ativa" : "Desativada";

        const gameCount = games.filter(game => game.sourceId === source.id).length;

        return `
            <article class="source-card" data-source-id="${escapeHTML(source.id)}">
                <div class="source-card-icon">◈</div>

                <div class="source-card-info">
                    <h3>${escapeHTML(source.name)}</h3>
                    <p>${escapeHTML(source.url || `https://github.com/${source.owner}/${source.repo}`)}</p>

                    <div class="source-card-meta">
                        <span>${escapeHTML(getPlatformLabel(source.platform === "auto" ? "flash" : source.platform))}</span>
                        <span>${gameCount} jogos</span>
                        <span>${source.required ? "Obrigatória" : source.custom ? "Personalizada" : "Original"}</span>
                        ${source.path ? `<span>/${escapeHTML(source.path)}</span>` : ""}
                    </div>

                    ${source.lastError ? `<p class="source-error">${escapeHTML(source.lastError)}</p>` : ""}
                    <span class="source-status ${statusClass}">${statusText}</span>
                </div>

                <div class="source-card-actions">
                    <button class="source-action-button" data-source-refresh="${escapeHTML(source.id)}">↻ Atualizar</button>
                    ${source.required ? "" : `<button class="source-action-button" data-source-toggle="${escapeHTML(source.id)}">${source.enabled ? "Desativar" : "Ativar"}</button>`}
                    ${source.custom ? `<button class="source-action-button danger" data-source-delete="${escapeHTML(source.id)}">Remover</button>` : ""}
                </div>
            </article>
        `;
    }).join("");
}

/* GAME CARDS */

function createGameCard(game) {
    const isFavorite = favorites.includes(game.id);
    const platform = getPlatformLabel(game.type);
    const origin = getGameOrigin(game);

    const originNames = {
        native: "Fonte original",
        github: "GitHub",
        url: "URL",
        local: "Arquivo local"
    };

    return `
        <article class="game-card" data-game-id="${escapeHTML(game.id)}">
            <div class="game-cover" data-cover-game="${escapeHTML(game.id)}">
                <div class="game-cover-placeholder" aria-label="Capa sendo carregada"><span class="cover-loading-mark"></span></div>

                <span class="game-platform">${escapeHTML(platform)}</span>

                <button
                    class="favorite-button ${isFavorite ? "is-favorite" : ""}"
                    data-favorite="${escapeHTML(game.id)}"
                    title="Adicionar aos favoritos"
                >
                    ${isFavorite ? "♥" : "♡"}
                </button>
            </div>

            <div class="game-info">
                <h3 title="${escapeHTML(game.name)}">${escapeHTML(game.name)}</h3>
                <p>${escapeHTML(game.source || "Minha biblioteca")}</p>

                <div class="game-card-footer">
                    <span class="game-category">${escapeHTML(CATEGORY_NAMES[game.category] || "Outros")}</span>
                    <button class="play-button" data-play="${escapeHTML(game.id)}">▶ JOGAR</button>
                </div>

                <span class="game-source">${escapeHTML(originNames[origin] || "Biblioteca")}</span>
            </div>
        </article>
    `;
}

function renderGames(container, list, emptyMessage) {
    if (!container) return;

    if (!list.length) {
        container.innerHTML = `
            <div class="empty-state">${escapeHTML(emptyMessage)}</div>
        `;
        return;
    }

    container.innerHTML = list.map(createGameCard).join("");
    hydrateGameCovers(container, list);
}

function getFilteredGames() {
    let list = [...games];

    if (currentCategory !== "todos") {
        list = list.filter(game => game.category === currentCategory);
    }

    if (currentFilter !== "todos") {
        list = list.filter(game => game.type === currentFilter);
    }

    if (currentSourceFilter !== "todos") {
        list = list.filter(game => getGameOrigin(game) === currentSourceFilter);
    }

    const search = $("#search-input")?.value.trim().toLowerCase();

    if (search) {
        list = list.filter(game =>
            game.name.toLowerCase().includes(search) ||
            game.category.toLowerCase().includes(search) ||
            game.source.toLowerCase().includes(search)
        );
    }

    const sort = $("#sort-games")?.value;

    if (sort === "name") {
        list.sort((a, b) => a.name.localeCompare(b.name));
    }

    if (sort === "recent") {
        list.sort((a, b) => {
            const aIndex = recentGames.indexOf(a.id);
            const bIndex = recentGames.indexOf(b.id);
            return (aIndex === -1 ? Infinity : aIndex) - (bIndex === -1 ? Infinity : bIndex);
        });
    }

    if (sort === "platform") {
        list.sort((a, b) => a.type.localeCompare(b.type));
    }

    return list;
}

function renderAll() {
    const featured = games.slice(0, 8);
    const filtered = getFilteredGames();

    renderGames($("#featured-games"), featured, "Nenhum jogo disponível.");
    renderGames($("#all-games"), filtered, "Nenhum jogo encontrado.");

    renderGames(
        $("#favorite-games"),
        games.filter(game => favorites.includes(game.id)),
        "Você ainda não possui favoritos."
    );

    renderGames(
        $("#recent-games"),
        recentGames.map(id => games.find(game => game.id === id)).filter(Boolean).slice(0, 4),
        "Seus jogos recentes aparecerão aqui."
    );

    renderGames(
        $("#recent-library"),
        recentGames.map(id => games.find(game => game.id === id)).filter(Boolean),
        "Você ainda não jogou nenhum jogo."
    );

    renderGames(
        $("#flash-games"),
        games.filter(game => game.type === "flash"),
        "Nenhum jogo Flash encontrado."
    );

    renderGames(
        $("#gba-games"),
        games.filter(game => game.type === selectedConsole),
        `Nenhum jogo ${getPlatformLabel(selectedConsole)} encontrado.`
    );

    if ($("#console-library-title")) {
        $("#console-library-title").textContent = `${getPlatformLabel(selectedConsole)}`;
    }

    if ($("#library-game-count")) {
        $("#library-game-count").textContent = `${games.length} jogos`;
    }

    if ($("#library-source-count")) {
        $("#library-source-count").textContent = `${sources.length} fontes`;
    }

    $("#library-empty")?.classList.toggle("hidden", filtered.length > 0);

    if ($("#library-empty")) {
        $("#library-empty").textContent = "Nenhum jogo encontrado.";
    }

    $$(".directory-card").forEach(card => {
        const source = sources.find(item => item.id === card.dataset.directory);
        const status = card.querySelector(".directory-status");

        if (source && status && source.gameCount) {
            status.textContent = `${source.gameCount} jogos`;
        }
    });

    saveGames();
}

/* NAVIGATION */

function navigateTo(page) {
    const target = document.getElementById(`page-${page}`);
    if (!target) return;

    $$(".page").forEach(item => item.classList.remove("active"));
    target.classList.add("active");

    $$(".nav-item").forEach(item => {
        item.classList.toggle("active", item.dataset.page === page);
    });

    const names = {
        home: "Início",
        library: "Biblioteca",
        favorites: "Favoritos",
        recent: "Recentes",
        flash: "Jogos Flash",
        "add-game": "Adicionar jogo",
        sources: "Gerenciador de fontes",
        backup: "Backup da biblioteca"
    };

    if ($("#current-page-name")) {
        $("#current-page-name").textContent = names[page] || page;
    }

    $("#sidebar")?.classList.remove("open");

    window.scrollTo({
        top: 0,
        behavior: "smooth"
    });

    if (page === "library") {
        renderGames($("#all-games"), getFilteredGames(), "Nenhum jogo encontrado.");
    }

    if (page === "sources") {
        renderSourceManager();
    }
}

function selectCategory(category) {
    currentCategory = category;
    currentFilter = "todos";

    $$(".filter-button").forEach(button => {
        button.classList.toggle("active", button.dataset.filter === "todos");
    });

    navigateTo("library");
    renderAll();
}

/* FAVORITES */

function toggleFavorite(id) {
    if (favorites.includes(id)) {
        favorites = favorites.filter(item => item !== id);
        showToast("Jogo removido dos favoritos.");
    } else {
        favorites.push(id);
        showToast("Jogo adicionado aos favoritos.");
    }

    saveFavorites();
    renderAll();
}

/* RECENT GAMES */

function addRecent(id) {
    recentGames = recentGames.filter(item => item !== id);
    recentGames.unshift(id);
    recentGames = recentGames.slice(0, 50);

    saveRecent();
    renderAll();
}

/* PLAYER */

function openPlayer(game) {
    if (!game) return;

    currentGame = game;
    addRecent(game.id);

    $("#player-game-title").textContent = game.name;
    $("#player-game-platform").textContent = getPlatformLabel(game.type);
    $("#player-status").textContent = "CARREGANDO JOGO";
    $("#player-modal").classList.remove("hidden");

    const content = $("#player-content");
    content.innerHTML = "";

    if (currentObjectURL) {
        URL.revokeObjectURL(currentObjectURL);
        currentObjectURL = null;
    }

    if (game.type === "flash") {
        loadFlashGame(game, content);
    } else if (game.type === "html5") {
        loadHTMLGame(game, content);
    } else if (EMULATOR_CORES[game.type]) {
        loadEmulatorGame(game, content);
    } else {
        showToast("Formato de jogo não suportado.", "error");
    }
}

function loadHTMLGame(game, content) {
    const iframe = document.createElement("iframe");

    iframe.style.width = "100%";
    iframe.style.height = "100%";
    iframe.style.minHeight = "500px";
    iframe.style.border = "0";
    iframe.style.background = "#08090d";
    iframe.allow = "autoplay; fullscreen; gamepad; clipboard-read; clipboard-write";
    iframe.setAttribute(
        "sandbox",
        "allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-downloads allow-modals"
    );
    iframe.title = game.name;

    iframe.onload = () => {
        $("#player-status").textContent = "JOGO HTML5 CARREGADO";
    };

    iframe.onerror = () => {
        $("#player-status").textContent = "ERRO AO CARREGAR";
        showToast("Não foi possível carregar este jogo HTML5.", "error");
    };

    content.appendChild(iframe);
    iframe.src = game.url;
}

function loadFlashGame(game, content) {
    try {
        const ruffle = window.RufflePlayer;

        if (!ruffle) {
            throw new Error("Ruffle não foi carregado.");
        }

        const player = ruffle.newest().createPlayer();

        player.style.width = "100%";
        player.style.height = "100%";
        player.style.minHeight = "450px";

        content.appendChild(player);

        player.load(game.url).then(() => {
            $("#player-status").textContent = "JOGO CARREGADO";
        }).catch(error => {
            console.error(error);
            $("#player-status").textContent = "ERRO AO CARREGAR";

            showToast(
                "Não foi possível executar este SWF. O arquivo pode estar indisponível ou ser incompatível.",
                "error"
            );
        });

    } catch (error) {
        console.error(error);

        content.innerHTML = `
            <div class="player-placeholder">
                <span>⚠️</span>
                <p>${escapeHTML(error.message)}</p>
            </div>
        `;

        $("#player-status").textContent = "ERRO";
    }
}

function loadEmulatorGame(game, content) {
    if (game.type === "psx" || game.type === "psp") {
        localStorage.setItem(`fm_pending_${game.type}`, JSON.stringify(game));
        window.location.href = `paginas/${game.type}.html`;
        return;
    }

    const core = EMULATOR_CORES[game.type];

    if (!core) {
        showToast("Este console não possui um núcleo configurado.", "error");
        return;
    }

    const iframe = document.createElement("iframe");

    iframe.style.width = "100%";
    iframe.style.height = "100%";
    iframe.style.minHeight = "500px";
    iframe.style.border = "0";
    iframe.allow = "autoplay; fullscreen; gamepad";
    iframe.title = `Emulador ${getPlatformLabel(game.type)}`;

    content.appendChild(iframe);

    const emulatorHTML = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width,initial-scale=1">
            <style>
                * { box-sizing: border-box; }
                html, body {
                    margin: 0;
                    width: 100%;
                    height: 100%;
                    background: #08090d;
                    overflow: hidden;
                }
                #game {
                    width: 100%;
                    height: 100%;
                    min-height: 500px;
                }
            </style>
        </head>
        <body>
            <div id="game"></div>
            <script>
                window.EJS_player = "#game";
                window.EJS_core = ${JSON.stringify(core)};
                window.EJS_gameUrl = ${JSON.stringify(game.url)};
                window.EJS_pathtodata = ${JSON.stringify(CONFIG.emulatorData)};
                window.EJS_gameName = ${JSON.stringify(game.name)};
                window.EJS_color = "#ff7043";
                window.EJS_startOnLoaded = true;
            <\/script>
            <script src="${CONFIG.emulatorData}loader.js"><\/script>
        </body>
        </html>
    `;

    iframe.srcdoc = emulatorHTML;

    iframe.onload = () => {
        $("#player-status").textContent = "EMULADOR INICIADO";
    };

    iframe.onerror = () => {
        $("#player-status").textContent = "ERRO NO EMULADOR";
        showToast("Falha ao iniciar o EmulatorJS.", "error");
    };
}

function closePlayer() {
    $("#player-modal").classList.add("hidden");
    $("#player-content").innerHTML = "";

    if (currentObjectURL) {
        URL.revokeObjectURL(currentObjectURL);
        currentObjectURL = null;
    }

    currentGame = null;
    $("#player-status").textContent = "AGUARDANDO JOGO";
}

function fullscreenPlayer() {
    const content = $("#player-content");

    if (!document.fullscreenElement) {
        content.requestFullscreen?.().catch(() => {
            showToast("Não foi possível ativar a tela cheia.", "error");
        });
    } else {
        document.exitFullscreen?.();
    }
}

/* LOCAL FILES */

function detectFileType(file) {
    const extension = file.name.split(".").pop().toLowerCase();

    for (const [platform, info] of Object.entries(PLATFORM_INFO)) {
        if (info.extension.includes(extension)) {
            return platform;
        }
    }

    if (extension === "zip") {
        return selectedConsole === "arcade" ? "arcade" : selectedConsole;
    }

    return null;
}

function setSelectedFile(file) {
    if (!file) return;

    const type = detectFileType(file);

    if (!type) {
        showToast("Formato de arquivo não suportado.", "error");
        return;
    }

    if (file.size > CONFIG.maxFileSize) {
        showToast("O arquivo ultrapassa o limite de 100 MB.", "error");
        return;
    }

    selectedFile = file;

    const area = $("#upload-area");

    if (area) {
        const title = area.querySelector("h3");
        const description = area.querySelector("p");

        if (title) title.textContent = file.name;

        if (description) {
            description.textContent =
                `${(file.size / 1024 / 1024).toFixed(2)} MB · ${getPlatformLabel(type)}`;
        }
    }

    const nameInput = $("#game-name");

    if (nameInput && !nameInput.value) {
        nameInput.value = normalizeName(file.name);
    }
}

async function handleLocalGame(event) {
    event.preventDefault();

    if (!selectedFile) {
        showToast("Selecione um arquivo primeiro.", "error");
        return;
    }

    const name = $("#game-name")?.value.trim();

    if (!name) {
        showToast("Digite o nome do jogo.", "error");
        return;
    }

    const type = detectFileType(selectedFile);
    const category = $("#game-category")?.value || "outros";
    const id = crypto.randomUUID();

    try {
        const game = {
            id,
            name,
            type,
            category,
            source: "Arquivo local",
            origin: "local"
        };

        await saveLocalGame(game, selectedFile);

        const url = URL.createObjectURL(selectedFile);

        addGame({
            ...game,
            url,
            local: true,
            fileId: id
        });

        showToast("Jogo adicionado com sucesso!");

        selectedFile = null;
        $("#add-file-form").reset();

        const title = $("#upload-area h3");
        const description = $("#upload-area p");

        if (title) title.textContent = "Selecione seu jogo";

        if (description) {
            description.textContent = "Arraste seu arquivo até aqui ou clique para procurar.";
        }

        renderAll();
        navigateTo("library");

    } catch (error) {
        console.error(error);
        showToast("Não foi possível salvar o jogo.", "error");
    }
}

/* CUSTOM URL */

async function handleURLGame(event) {
    event.preventDefault();

    const name = $("#url-game-name")?.value.trim();
    const url = $("#game-url")?.value.trim();
    const type = $("#url-game-type")?.value;
    const category = $("#url-game-category")?.value || "outros";

    if (!name || !url) {
        showToast("Preencha todos os campos.", "error");
        return;
    }

    try {
        const parsed = new URL(url);

        if (!["http:", "https:"].includes(parsed.protocol)) {
            throw new Error("Endereço inválido.");
        }

        const extension = parsed.pathname.split(".").pop().toLowerCase();

        if (type === "flash" && extension !== "swf") {
            showToast("O link precisa apontar para um arquivo SWF.", "error");
            return;
        }

        if (type === "html5" && !["html", "htm"].includes(extension)) {
            showToast("O link precisa apontar para um arquivo HTML.", "error");
            return;
        }

        if (type !== "flash" && type !== "html5" && !PLATFORM_INFO[type]?.extension.includes(extension) && extension !== "zip") {
            showToast("A extensão do arquivo não corresponde ao console selecionado.", "error");
            return;
        }

        if (addGame({
            name,
            url,
            type,
            category,
            source: "URL personalizada",
            origin: "url"
        })) {
            showToast("Jogo adicionado à biblioteca!");
        } else {
            showToast("Este jogo já está na biblioteca.", "error");
        }

        $("#add-url-form").reset();
        renderAll();
        navigateTo("library");

    } catch (error) {
        showToast(error.message || "URL inválida.", "error");
    }
}

/* CONSOLE UPLOAD */

async function handleRomUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const type = detectFileType(file);

    if (!type || type === "flash" || type === "html5") {
        showToast("Selecione uma ROM de console compatível.", "error");
        event.target.value = "";
        return;
    }

    if (file.size > CONFIG.maxFileSize) {
        showToast("O arquivo ultrapassa o limite de 100 MB.", "error");
        event.target.value = "";
        return;
    }

    try {
        const id = crypto.randomUUID();
        const name = normalizeName(file.name);
        const category = guessCategory(name);

        await saveLocalGame({
            id,
            name,
            type,
            category
        }, file);

        const url = URL.createObjectURL(file);

        const game = {
            id,
            name,
            url,
            type,
            category,
            source: "Arquivo local",
            origin: "local",
            local: true,
            fileId: id
        };

        addGame(game);

        selectedConsole = type;
        renderAll();

        showToast(`${getPlatformLabel(type)} carregado!`);
        openPlayer(game);

    } catch (error) {
        console.error(error);
        showToast("Não foi possível salvar a ROM.", "error");
    }

    event.target.value = "";
}

/* ADD GAME TABS */

function switchAddTab(type) {
    $$(".add-tab").forEach(tab => {
        tab.classList.toggle("active", tab.dataset.addType === type);
    });

    $("#add-file-form")?.classList.toggle("hidden", type !== "file");
    $("#add-url-form")?.classList.toggle("hidden", type !== "url");
}

/* SEARCH */

function searchGames() {
    renderAll();

    if ($(".page.active")?.id === "page-library") {
        renderGames($("#all-games"), getFilteredGames(), "Nenhum jogo encontrado.");
    }
}

/* RANDOM GAME */

function randomGame() {
    if (!games.length) {
        showToast("Nenhum jogo disponível.", "error");
        return;
    }

    openPlayer(games[Math.floor(Math.random() * games.length)]);
}

/* BACKUP */

function exportLibrary() {
    const backup = {
        format: "JoglumeBackup",
        version: 3,
        exportedAt: new Date().toISOString(),
        sources,
        games: games.filter(game => !game.local),
        favorites,
        recentGames,
        settings: {
            currentCategory,
            currentFilter,
            currentSourceFilter
        }
    };

    const blob = new Blob(
        [JSON.stringify(backup, null, 2)],
        { type: "application/json" }
    );

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `joglume-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();

    URL.revokeObjectURL(url);

    showToast("Backup JSON exportado.");
}

async function importLibrary(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
        const content = await file.text();
        const backup = JSON.parse(content);

        if (!backup || !["JoglumeBackup", "FlashManiaBackup"].includes(backup.format)) {
            throw new Error("Este arquivo não é um backup válido do Joglume.");
        }

        if (Array.isArray(backup.sources)) {
            for (const importedSource of backup.sources) {
                const existingIndex = sources.findIndex(source =>
                    source.id === importedSource.id ||
                    (source.owner === importedSource.owner &&
                     source.repo === importedSource.repo &&
                     (source.path || "") === (importedSource.path || ""))
                );

                if (existingIndex >= 0) {
                    sources[existingIndex] = {
                        ...sources[existingIndex],
                        ...importedSource
                    };
                } else {
                    sources.push(importedSource);
                }
            }

            saveSources();
        }

        if (Array.isArray(backup.games)) {
            backup.games.forEach(game => addGame(game));
            saveGames();
        }

        if (Array.isArray(backup.favorites)) {
            favorites = [...new Set([...favorites, ...backup.favorites])];
            saveFavorites();
        }

        if (Array.isArray(backup.recentGames)) {
            recentGames = [...new Set([...recentGames, ...backup.recentGames])].slice(0, 50);
            saveRecent();
        }

        renderAll();
        renderSourceManager();

        showToast("Backup importado com sucesso!");

    } catch (error) {
        showToast(error.message || "Não foi possível importar o backup.", "error");
    }

    event.target.value = "";
}

async function clearImportedGames() {
    const imported = games.filter(game =>
        game.origin === "github" ||
        game.origin === "url" ||
        game.sourceId
    );

    const importedIds = imported.map(game => game.id);

    games = games.filter(game => !importedIds.includes(game.id));
    favorites = favorites.filter(id => !importedIds.includes(id));
    recentGames = recentGames.filter(id => !importedIds.includes(id));

    for (const source of sources) {
        source.gameCount = 0;
    }

    saveGames();
    saveFavorites();
    saveRecent();
    saveSources();

    renderAll();
    renderSourceManager();

    showToast("Jogos importados removidos. As fontes foram mantidas.");
}

function resetSources() {
    const customSources = sources.filter(source => source.custom);

    sources = getInitialSources();

    customSources.forEach(source => {
        if (!sources.some(item =>
            item.owner === source.owner &&
            item.repo === source.repo &&
            (item.path || "") === (source.path || "")
        )) {
            sources.push(source);
        }
    });

    saveSources();
    renderSourceManager();

    showToast("Fontes originais restauradas.");
}

/* HTML5 OPTIONS */

function addHTML5Options() {
    const sourcePlatform = $("#source-platform");
    const urlGameType = $("#url-game-type");

    if (sourcePlatform && !sourcePlatform.querySelector('option[value="html5"]')) {
        const option = document.createElement("option");
        option.value = "html5";
        option.textContent = "HTML5";
        sourcePlatform.appendChild(option);
    }

    if (urlGameType && !urlGameType.querySelector('option[value="html5"]')) {
        const option = document.createElement("option");
        option.value = "html5";
        option.textContent = "HTML5";
        urlGameType.appendChild(option);
    }

    const gameFile = $("#game-file");

    if (gameFile && !gameFile.accept.includes(".html")) {
        gameFile.accept += ",.html,.htm";
    }

    const uploadDescription = $("#upload-area span");

    if (uploadDescription) {
        uploadDescription.textContent = "SWF, HTML, GBA, GBC, GB ou ZIP";
    }

    const filterButtons = $(".filter-buttons");

    if (filterButtons && !filterButtons.querySelector('[data-filter="html5"]')) {
        const button = document.createElement("button");
        button.className = "filter-button";
        button.dataset.filter = "html5";
        button.textContent = "HTML5";
        filterButtons.appendChild(button);
    }
}

/* EVENTS */

function initializeEvents() {
    document.addEventListener("click", event => {
        const pageButton = event.target.closest("[data-page]");

        if (pageButton) {
            navigateTo(pageButton.dataset.page);
        }

        const categoryButton = event.target.closest("[data-category]");

        if (categoryButton) {
            selectCategory(categoryButton.dataset.category);
        }

        const favoriteButton = event.target.closest("[data-favorite]");

        if (favoriteButton) {
            toggleFavorite(favoriteButton.dataset.favorite);
        }

        const playButton = event.target.closest("[data-play]");

        if (playButton) {
            const game = games.find(item => item.id === playButton.dataset.play);
            openPlayer(game);
        }

        const filterButton = event.target.closest("[data-filter]");

        if (filterButton) {
            currentFilter = filterButton.dataset.filter;

            $$(".filter-button").forEach(button => {
                button.classList.toggle("active", button === filterButton);
            });

            renderGames($("#all-games"), getFilteredGames(), "Nenhum jogo encontrado.");
        }

        const addTab = event.target.closest("[data-add-type]");

        if (addTab) {
            switchAddTab(addTab.dataset.addType);
        }

        const consoleButton = event.target.closest("[data-console]");

        if (consoleButton) {
            selectedConsole = consoleButton.dataset.console;

            $$(".console-card").forEach(button => {
                button.classList.toggle("active", button === consoleButton);
            });

            renderAll();

            const supported = Boolean(EMULATOR_CORES[selectedConsole]);

            if (!supported) {
                showToast("Este console ainda não possui um núcleo configurado.", "error");
            }
        }

        const refreshButton = event.target.closest("[data-source-refresh]");

        if (refreshButton) {
            refreshSource(refreshButton.dataset.sourceRefresh);
        }

        const toggleButton = event.target.closest("[data-source-toggle]");

        if (toggleButton) {
            toggleSource(toggleButton.dataset.sourceToggle);
        }

        const deleteButton = event.target.closest("[data-source-delete]");

        if (deleteButton) {
            deleteSource(deleteButton.dataset.sourceDelete);
        }
    });

    $("#menu-toggle")?.addEventListener("click", () => {
        $("#sidebar")?.classList.toggle("open");
    });

    $("#close-player")?.addEventListener("click", closePlayer);
    $("#fullscreen-button")?.addEventListener("click", fullscreenPlayer);

    $("#player-modal")?.addEventListener("click", event => {
        if (event.target.id === "player-modal") {
            closePlayer();
        }
    });

    $("#search-input")?.addEventListener("input", searchGames);

    $("#random-game")?.addEventListener("click", randomGame);

    $("#explore-games")?.addEventListener("click", () => {
        navigateTo("library");
    });

    $("#sort-games")?.addEventListener("change", () => {
        renderGames($("#all-games"), getFilteredGames(), "Nenhum jogo encontrado.");
    });

    $("#source-filter")?.addEventListener("change", event => {
        currentSourceFilter = event.target.value;
        renderGames($("#all-games"), getFilteredGames(), "Nenhum jogo encontrado.");
    });

    $("#game-file")?.addEventListener("change", event => {
        setSelectedFile(event.target.files[0]);
    });

    $("#add-file-form")?.addEventListener("submit", handleLocalGame);
    $("#add-url-form")?.addEventListener("submit", handleURLGame);
    $("#rom-input")?.addEventListener("change", handleRomUpload);

    $("#add-source-form")?.addEventListener("submit", addGitHubSource);

    $("#refresh-all-sources")?.addEventListener("click", () => {
        loadAllDirectories();
    });

    $("#export-library")?.addEventListener("click", exportLibrary);

    $("#import-library-file")?.addEventListener("change", importLibrary);

    $("#clear-imported-games")?.addEventListener("click", clearImportedGames);

    $("#reset-sources")?.addEventListener("click", resetSources);

    $("#upload-area")?.addEventListener("dragover", event => {
        event.preventDefault();
        $("#upload-area")?.classList.add("dragover");
    });

    $("#upload-area")?.addEventListener("dragleave", () => {
        $("#upload-area")?.classList.remove("dragover");
    });

    $("#upload-area")?.addEventListener("drop", event => {
        event.preventDefault();
        $("#upload-area")?.classList.remove("dragover");
        setSelectedFile(event.dataTransfer.files[0]);
    });

    document.addEventListener("keydown", event => {
        if (event.ctrlKey && event.key.toLowerCase() === "k") {
            event.preventDefault();
            $("#search-input")?.focus();
        }

        if (event.key === "Escape" && $("#player-modal") && !$("#player-modal").classList.contains("hidden")) {
            closePlayer();
        }
    });
}

/* AUTO UPDATE */

async function autoUpdateSources() {
    const lastUpdate = Number(localStorage.getItem(STORAGE_KEYS.lastUpdate) || 0);

    if (Date.now() - lastUpdate < CONFIG.autoUpdateInterval) return;

    const pending = sources.filter(source =>
        source.enabled &&
        source.autoUpdate &&
        (!source.lastUpdated || Date.now() - source.lastUpdated >= CONFIG.autoUpdateInterval)
    );

    if (!pending.length) return;

    for (const source of pending) {
        await loadDirectory(source);
    }

    localStorage.setItem(STORAGE_KEYS.lastUpdate, String(Date.now()));
    renderAll();
    renderSourceManager();
}

/* INITIALIZATION */

async function initializeJoglume() {
    addHTML5Options();
    initializeEvents();

    loadSavedSources();
    loadSavedGames();

    renderAll();
    renderSourceManager();

    try {
        await openDatabase();
        await restoreLocalGames();
    } catch (error) {
        console.error("Banco de dados:", error);
        showToast("Não foi possível restaurar alguns jogos locais.", "error");
    }

    renderAll();

    const lastUpdate = Number(localStorage.getItem(STORAGE_KEYS.lastUpdate) || 0);
    const shouldUpdate = !lastUpdate || Date.now() - lastUpdate >= CONFIG.autoUpdateInterval;

    if (shouldUpdate) {
        autoUpdateSources();
    } else {
        sources
            .filter(source => source.enabled && source.autoUpdate && !source.lastUpdated)
            .forEach(source => loadDirectory(source));
    }

    console.log("JOGLUME 3.0 iniciado.");
}

document.addEventListener("DOMContentLoaded", initializeJoglume);