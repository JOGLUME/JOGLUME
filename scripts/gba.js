"use strict";

const GBA_CONFIG = {
    dataPath: "https://cdn.emulatorjs.org/stable/data/",
    githubApi: "https://api.github.com/repos/",
    maxRomSize: 100 * 1024 * 1024,
    recentKey: "fm_gba_recent_v1",
    sourcesKey: "fm_sources_v3",
    gamesKey: "fm_games_v3",
    updateInterval: 6 * 60 * 60 * 1000
};

const $ = selector => document.querySelector(selector);
let currentRom = null;
let currentRomUrl = null;
let emulatorScript = null;
let recentRoms = JSON.parse(localStorage.getItem(GBA_CONFIG.recentKey) || "[]");

function toast(message, type = "success") {
    const item = document.createElement("div");
    item.className = `toast${type === "error" ? " error" : ""}`;
    item.textContent = message;
    $("#toast-container").appendChild(item);
    setTimeout(() => item.remove(), 3800);
}

function focusPlayer() {
    const player = $(".player-card");
    if (!player) return;
    requestAnimationFrame(() => player.scrollIntoView({ behavior: "smooth", block: "start" }));
}

function setStatus(message) {
    $("#player-state").textContent = message.toUpperCase();
}

function cleanName(value) {
    return String(value || "Jogo GBA").split("/").pop().replace(/\.gba$/i, "").replace(/[_-]+/g, " ").trim() || "Jogo GBA";
}

function normalizeGitHubURL(value) {
    let url;
    try { url = new URL(value); } catch { throw new Error("Informe um link válido do GitHub."); }
    if (url.hostname !== "github.com") throw new Error("O endereço precisa ser do github.com.");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) throw new Error("Informe o usuário e o repositório.");
    return {
        owner: parts[0],
        repo: parts[1].replace(/\.git$/i, ""),
        branch: parts[2] === "tree" || parts[2] === "blob" ? parts[3] : "",
        path: parts[2] === "tree" || parts[2] === "blob" ? parts.slice(4).join("/") : ""
    };
}

async function githubJSON(url) {
    const response = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
    if (response.status === 403 || response.status === 429) throw new Error("O GitHub limitou as consultas temporariamente. Tente novamente mais tarde.");
    if (!response.ok) throw new Error(`Falha ao consultar o GitHub (${response.status}). Confira se o repositório é público.`);
    return response.json();
}

function rawGitHubURL(owner, repo, branch, path) {
    const safeBranch = branch.split("/").map(encodeURIComponent).join("/");
    return `https://raw.githubusercontent.com/${owner}/${repo}/${safeBranch}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

async function findGitHubRoms(input) {
    const parsed = normalizeGitHubURL(input);
    const repoInfo = await githubJSON(`${GBA_CONFIG.githubApi}${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`);
    const branch = parsed.branch || repoInfo.default_branch;
    const tree = await githubJSON(`${GBA_CONFIG.githubApi}${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    if (tree.truncated) throw new Error("Este repositório é muito grande para ser listado de uma só vez. Informe o link de uma pasta mais específica.");
    const prefix = parsed.path ? parsed.path.replace(/\/?$/, "/") : "";
    const files = (tree.tree || []).filter(entry =>
        entry.type === "blob" &&
        entry.path.toLowerCase().endsWith(".gba") &&
        (!prefix || entry.path.startsWith(prefix))
    );
    return files.map(file => ({
        name: cleanName(file.path),
        path: file.path,
        size: file.size || 0,
        url: rawGitHubURL(parsed.owner, parsed.repo, branch, file.path),
        source: `${parsed.owner}/${parsed.repo}`
    }));
}

function readStorageJSON(key, fallback) {
    try { const value = JSON.parse(localStorage.getItem(key) || "null"); return value ?? fallback; }
    catch { return fallback; }
}
function ensureDefaultSources() {
    const defaults = [
        { id: "gba-roms", name: "Game Boy Advance ROMs", owner: "CleberDevOps", repo: "roms-gameboy-advanced", branch: "master", category: "rpg", platform: "gba", origin: "native", url: "https://github.com/CleberDevOps/roms-gameboy-advanced", enabled: true, autoUpdate: true, recursive: true, custom: false, lastUpdated: 0, gameCount: 0, status: "pending" },
        { id: "offline-html-games", name: "Offline HTML Games Pack", owner: "CoolDude2349", repo: "Offline-HTML-Games-Pack", branch: "master", category: "acao", platform: "html5", origin: "native", url: "https://github.com/CoolDude2349/Offline-HTML-Games-Pack", enabled: true, autoUpdate: true, recursive: true, custom: false, lastUpdated: 0, gameCount: 0, status: "pending" },
        { id: "flash-games-directory", name: "Flash Games Directory", owner: "AmmarSAA", repo: "flash-games-directory", branch: "main", category: "acao", platform: "flash", origin: "native", url: "https://github.com/AmmarSAA/flash-games-directory", enabled: true, autoUpdate: true, recursive: true, custom: false, lastUpdated: 0, gameCount: 0, status: "pending" },
        { id: "snes-dolchi21", name: "SNES ROMs · Dolchi21", owner: "dolchi21-retroarch", repo: "snes-roms", branch: "master", category: "auto", platform: "snes", extensions: ["7z", "zip"], required: true, origin: "native", url: "https://github.com/dolchi21-retroarch/snes-roms", enabled: true, autoUpdate: true, recursive: true, custom: false, lastUpdated: 0, gameCount: 0, status: "pending" },
        { id: "snes-coop", name: "SNES Co-op Retro Games", owner: "hacan359", repo: "co-op-retro-games", branch: "main", path: "roms/snes", url: "https://github.com/hacan359/co-op-retro-games/tree/main/roms/snes", category: "auto", platform: "snes", extensions: ["zip", "7z", "sfc", "smc"], required: true, origin: "native", url: "https://github.com/hacan359/co-op-retro-games/tree/main/roms/snes", enabled: true, autoUpdate: true, recursive: true, custom: false, lastUpdated: 0, gameCount: 0, status: "pending" },
        { id: "megadrive-homebrew", name: "Mega Drive Homebrew · RetroBrews", owner: "retrobrews", repo: "md-games", branch: "", category: "auto", platform: "segaMD", extensions: ["bin"], required: true, origin: "native", url: "https://github.com/retrobrews/md-games", enabled: true, autoUpdate: true, recursive: true, custom: false, lastUpdated: 0, gameCount: 0, status: "pending" }
    ];
    const saved = readStorageJSON(GBA_CONFIG.sourcesKey, null);
    if (!Array.isArray(saved)) {
        localStorage.setItem(GBA_CONFIG.sourcesKey, JSON.stringify(defaults));
        return;
    }
    const merged = defaults.map(item => ({ ...item, ...(saved.find(entry => entry.id === item.id) || {}) }));
    merged.forEach(source => { if (source.required) source.enabled = true; });
    saved.filter(item => item.custom && !merged.some(source => source.id === item.id)).forEach(item => merged.push(item));
    localStorage.setItem(GBA_CONFIG.sourcesKey, JSON.stringify(merged));
}
function getSavedGbaSources() {
    return readStorageJSON(GBA_CONFIG.sourcesKey, []).filter(source => source.enabled !== false && (source.platform === "gba" || source.id === "gba-roms"));
}
function getSavedGbaGames() {
    return readStorageJSON(GBA_CONFIG.gamesKey, []).filter(game => game.type === "gba" && game.url);
}
function normalizeGbaSearch(value) {
    return String(value || "").toLocaleLowerCase("pt-BR").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}
function renderSavedGbaLibrary() {
    const sources = getSavedGbaSources();
    const allGames = getSavedGbaGames();
    const query = normalizeGbaSearch($("#saved-gba-search")?.value || "");
    const games = allGames.filter(game => normalizeGbaSearch([game.name, game.source, game.path].join(" ")).includes(query));
    const sourceBox = $("#saved-gba-sources");
    const gameBox = $("#saved-gba-list");
    if (!sourceBox || !gameBox) return;
    sourceBox.innerHTML = sources.length ? sources.map(source => {
        const count = allGames.filter(game => game.sourceId === source.id).length;
        const status = source.status === "error" ? "Erro na última atualização" : source.lastUpdated ? `Atualizada em ${new Date(source.lastUpdated).toLocaleString("pt-BR")}` : "Aguardando primeira importação";
        return `<article class="source-card"><div class="source-card-icon">🎮</div><div class="source-card-info"><h3>${escapeHTML(source.name)}</h3><p>${escapeHTML(source.url || `https://github.com/${source.owner}/${source.repo}`)}</p><div class="source-card-meta"><span>${count} ROM(s) salvas</span><span>${escapeHTML(status)}</span></div></div><div class="source-card-actions"><a class="source-action-button" href="fontes.html">Gerenciar fonte</a></div></article>`;
    }).join("") : '<div class="empty-state">Nenhuma fonte GBA ativa foi encontrada. Confira o gerenciador de fontes.</div>';
    if (!allGames.length) {
        gameBox.innerHTML = '<div class="empty-state">Ainda não há ROMs GBA importadas. Use “Atualizar fontes” ou abra o gerenciador de fontes.</div>';
        gameBox._games = [];
        return;
    }
    if (!games.length) {
        gameBox.innerHTML = '<div class="empty-state">Nenhum jogo encontrado com esse termo.</div>';
        gameBox._games = [];
        return;
    }
    gameBox.innerHTML = games.map((game, index) => `<article class="rom-item"><div><strong title="${escapeHTML(game.name)}">${escapeHTML(game.name)}</strong><small>${escapeHTML(game.source || "Fonte GBA")} · ${escapeHTML(game.path || "")}</small></div><button type="button" data-saved-gba="${index}">Jogar</button></article>`).join("");
    gameBox._games = games;
}
async function refreshSavedGbaSources(force = false) {
    const sources = getSavedGbaSources();
    if (!sources.length) { renderSavedGbaLibrary(); return; }
    const savedGames = readStorageJSON(GBA_CONFIG.gamesKey, []);
    let changed = false;
    for (const source of sources) {
        if (!force && source.autoUpdate === false) continue;
        if (!force && source.lastUpdated && Date.now() - source.lastUpdated < GBA_CONFIG.updateInterval) continue;
        try {
            const repo = await githubJSON(`${GBA_CONFIG.githubApi}${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}`);
            const branch = source.branch || repo.default_branch;
            const tree = await githubJSON(`${GBA_CONFIG.githubApi}${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
            if (tree.truncated) throw new Error("A árvore do repositório é grande demais; use uma pasta específica no gerenciador.");
            const prefix = source.path ? source.path.replace(/\/?$/, "/") : "";
            const files = (tree.tree || []).filter(item => item.type === "blob" && item.path.toLowerCase().endsWith(".gba") && (!prefix || item.path.startsWith(prefix)));
            const retained = savedGames.filter(game => game.sourceId !== source.id);
            const imported = files.slice(0, 1200).map(file => {
                const name = cleanName(file.path);
                return { id: `${source.id}-${file.path}`, name, url: rawGitHubURL(source.owner, source.repo, branch, file.path), type: "gba", category: source.category || "rpg", source: source.name, sourceId: source.id, path: file.path, origin: source.custom ? "github" : "native", local: false };
            });
            savedGames.splice(0, savedGames.length, ...retained, ...imported);
            source.branch = branch;
            source.gameCount = imported.length;
            source.lastUpdated = Date.now();
            source.status = "active";
            source.lastError = "";
            changed = true;
        } catch (error) {
            source.status = "error";
            source.lastError = error.message;
            changed = true;
            toast(`${source.name}: ${error.message}`, "error");
        }
    }
    if (changed) {
        localStorage.setItem(GBA_CONFIG.gamesKey, JSON.stringify(savedGames));
        localStorage.setItem(GBA_CONFIG.sourcesKey, JSON.stringify(readStorageJSON(GBA_CONFIG.sourcesKey, []).map(item => sources.find(source => source.id === item.id) || item)));
    }
    renderSavedGbaLibrary();
}

function addRecent(rom) {
    recentRoms = [rom, ...recentRoms.filter(item => item.url !== rom.url)].slice(0, 8);
    localStorage.setItem(GBA_CONFIG.recentKey, JSON.stringify(recentRoms));
    renderRecent();
}

function renderRecent() {
    const container = $("#recent-list");
    if (!recentRoms.length) {
        container.innerHTML = '<div class="empty-state">Seus jogos recentes aparecerão aqui.</div>';
        return;
    }
    container.innerHTML = recentRoms.map((rom, index) => `
        <article class="recent-item">
            <span class="recent-symbol">🎮</span>
            <div><strong title="${escapeHTML(rom.name)}">${escapeHTML(rom.name)}</strong><small>${escapeHTML(rom.source || "ROM GBA")}</small></div>
            <button type="button" data-recent="${index}">Jogar</button>
        </article>
    `).join("");
}

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    })[char]);
}

function clearEmulator(preserveUrl = null) {
    if (emulatorScript) {
        emulatorScript.remove();
        emulatorScript = null;
    }
    $("#game").innerHTML = "";
    if (currentRomUrl && currentRomUrl.startsWith("blob:") && currentRomUrl !== preserveUrl) URL.revokeObjectURL(currentRomUrl);
    currentRomUrl = null;
    window.EJS_player = undefined;
    window.EJS_gameUrl = undefined;
    window.EJS_core = undefined;
}

function startEmulator(rom) {
    if (!rom || !rom.url) return;
    clearEmulator(rom.url);
    currentRom = rom;
    currentRomUrl = rom.url;
    $("#screen-placeholder").hidden = true;
    $("#game-title").textContent = rom.name.toUpperCase();
    setStatus("CARREGANDO ROM");
    addRecent({ name: rom.name, url: rom.persistUrl || rom.url, source: rom.source || "ROM GBA" });
    focusPlayer();

    window.EJS_player = "#game";
    window.EJS_core = "gba";
    window.EJS_gameUrl = rom.url;
    window.EJS_gameName = rom.name;
    window.EJS_pathtodata = GBA_CONFIG.dataPath;
    window.EJS_color = "#ff7043";
    window.EJS_startOnLoaded = true;
    window.EJS_language = "pt-BR";
    window.EJS_backgroundColor = "#08090d";
    window.EJS_gameID = "flashmania-gba";

    emulatorScript = document.createElement("script");
    emulatorScript.src = `${GBA_CONFIG.dataPath}loader.js`;
    emulatorScript.async = true;
    emulatorScript.onload = () => setStatus("EMULADOR INICIADO");
    emulatorScript.onerror = () => {
        setStatus("ERRO AO INICIAR");
        toast("Não foi possível carregar o EmulatorJS. Verifique sua conexão.", "error");
    };
    document.body.appendChild(emulatorScript);
}

async function loadRemoteROM(url, name, source = "Link externo") {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error("Informe uma URL válida."); }
    if (!["https:", "http:"].includes(parsed.protocol)) throw new Error("Use um endereço HTTP ou HTTPS.");
    if (!/\.gba(?:$|[?#])/i.test(parsed.href)) throw new Error("O link precisa apontar para um arquivo .gba.");
    startEmulator({ name: name || cleanName(parsed.pathname), url: parsed.href, source, persistUrl: parsed.href });
}

function showROMResults(roms) {
    const section = $("#results-section");
    const list = $("#rom-list");
    section.hidden = false;
    if (!roms.length) {
        $("#results-description").textContent = "Nenhum arquivo .gba foi encontrado neste repositório.";
        list.innerHTML = '<div class="empty-state">Não foram encontradas ROMs GBA no caminho informado.</div>';
        return;
    }
    $("#results-description").textContent = `${roms.length} arquivo(s) encontrado(s). Selecione um para carregar.`;
    list.innerHTML = roms.map((rom, index) => `
        <article class="rom-item">
            <div><strong title="${escapeHTML(rom.name)}">${escapeHTML(rom.name)}</strong><small>${escapeHTML(rom.path)} · ${formatSize(rom.size)}</small></div>
            <button type="button" data-rom-index="${index}">Carregar</button>
        </article>
    `).join("");
    list._roms = roms;
}

function formatSize(bytes) {
    if (!bytes) return "Tamanho não informado";
    return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function handleLocalFile(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".gba")) {
        toast("Selecione um arquivo com extensão .gba.", "error");
        return;
    }
    if (file.size > GBA_CONFIG.maxRomSize) {
        toast("O arquivo ultrapassa o limite de 100 MB.", "error");
        return;
    }
    const url = URL.createObjectURL(file);
    $("#file-name").textContent = `${file.name} · ${formatSize(file.size)}`;
    startEmulator({ name: cleanName(file.name), url, source: "Arquivo local", persistUrl: `local:${file.name}` });
}

async function submitRepository(event) {
    event.preventDefault();
    const button = $("#search-repo");
    const original = button.innerHTML;
    button.disabled = true;
    button.textContent = "Buscando...";
    setStatus("CONSULTANDO GITHUB");
    try {
        const roms = await findGitHubRoms($("#github-url").value.trim());
        showROMResults(roms);
        setStatus("REPOSITÓRIO ANALISADO");
        if (!roms.length) toast("Nenhuma ROM GBA encontrada.", "error");
    } catch (error) {
        setStatus("ERRO NA BUSCA");
        toast(error.message, "error");
    } finally {
        button.disabled = false;
        button.innerHTML = original;
    }
}

function init() {
    ensureDefaultSources();
    $("#menu-toggle").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
    $("#rom-file").addEventListener("change", event => handleLocalFile(event.target.files[0]));
    $("#url-form").addEventListener("submit", async event => {
        event.preventDefault();
        try { await loadRemoteROM($("#rom-url").value.trim()); }
        catch (error) { toast(error.message, "error"); }
    });
    $("#github-form").addEventListener("submit", submitRepository);
    $("#rom-list").addEventListener("click", event => {
        const button = event.target.closest("[data-rom-index]");
        if (!button) return;
        const rom = $("#rom-list")._roms?.[Number(button.dataset.romIndex)];
        if (rom) startEmulator(rom);
    });
    $("#saved-gba-search")?.addEventListener("input", renderSavedGbaLibrary);
    $("#clear-saved-gba-search")?.addEventListener("click", () => { $("#saved-gba-search").value = ""; renderSavedGbaLibrary(); $("#saved-gba-search").focus(); });
    $("#saved-gba-list")?.addEventListener("click", event => {
        const button = event.target.closest("[data-saved-gba]");
        if (!button) return;
        const game = $("#saved-gba-list")._games?.[Number(button.dataset.savedGba)];
        if (game) loadRemoteROM(game.url, game.name, game.source).catch(error => toast(error.message, "error"));
    });
    $("#refresh-saved-gba")?.addEventListener("click", async () => {
        const button = $("#refresh-saved-gba");
        button.disabled = true;
        button.textContent = "Atualizando...";
        await refreshSavedGbaSources(true);
        button.disabled = false;
        button.textContent = "↻ Atualizar fontes";
    });
    $("#recent-list").addEventListener("click", event => {
        const button = event.target.closest("[data-recent]");
        if (!button) return;
        const rom = recentRoms[Number(button.dataset.recent)];
        if (!rom) return;
        if (rom.url.startsWith("local:")) {
            toast("ROM local precisa ser selecionada novamente após atualizar a página.", "error");
            return;
        }
        loadRemoteROM(rom.url, rom.name, rom.source).catch(error => toast(error.message, "error"));
    });
    $("#clear-results").addEventListener("click", () => {
        $("#results-section").hidden = true;
        $("#rom-list").innerHTML = "";
    });
    $("#clear-recent").addEventListener("click", () => {
        recentRoms = [];
        localStorage.removeItem(GBA_CONFIG.recentKey);
        renderRecent();
        toast("Histórico limpo.");
    });
    $("#fullscreen").addEventListener("click", async () => {
        const target = $("#screen-wrap");
        try {
            if (!document.fullscreenElement) await target.requestFullscreen();
            else await document.exitFullscreen();
        } catch { toast("Não foi possível ativar a tela cheia.", "error"); }
    });
    $("#reset-game").addEventListener("click", () => {
        if (!currentRom) {
            toast("Carregue uma ROM primeiro.", "error");
            return;
        }
        startEmulator(currentRom);
    });
    renderRecent();
    renderSavedGbaLibrary();
    refreshSavedGbaSources(false);
}

document.addEventListener("DOMContentLoaded", init);
