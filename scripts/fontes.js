"use strict";

const SOURCE_KEY = "fm_sources_v3";
const GAMES_KEY = "fm_games_v3";
const SOURCE_DEFAULTS = [
    { id: "gba-roms", name: "Game Boy Advance ROMs", owner: "CleberDevOps", repo: "roms-gameboy-advanced", branch: "master", category: "rpg", platform: "gba", origin: "native" },
    { id: "offline-html-games", name: "Offline HTML Games Pack", owner: "CoolDude2349", repo: "Offline-HTML-Games-Pack", branch: "master", category: "acao", platform: "html5", origin: "native" },
    { id: "flash-games-directory", name: "Flash Games Directory", owner: "AmmarSAA", repo: "flash-games-directory", branch: "main", category: "acao", platform: "flash", origin: "native" },
    { id: "snes-dolchi21", name: "SNES ROMs · Dolchi21", owner: "dolchi21-retroarch", repo: "snes-roms", branch: "master", category: "auto", platform: "snes", extensions: ["zip"], required: true, origin: "native" },
    { id: "snes-coop", name: "SNES Co-op Retro Games", owner: "hacan359", repo: "co-op-retro-games", branch: "main", path: "roms/snes", url: "https://github.com/hacan359/co-op-retro-games/tree/main/roms/snes", category: "auto", platform: "snes", extensions: ["zip", "sfc", "smc"], required: true, origin: "native" },
    { id: "megadrive-homebrew", name: "Mega Drive Homebrew · RetroBrews", owner: "retrobrews", repo: "md-games", branch: "", category: "auto", platform: "segaMD", extensions: ["bin", "md", "gen", "smd"], required: true, origin: "native" }
];
const EXTENSIONS = {
    flash: ["swf"], html5: ["html", "htm"], gba: ["gba"], gbc: ["gbc"], gb: ["gb"], nes: ["nes"],
    snes: ["sfc", "smc"], nds: ["nds"], n64: ["z64", "n64", "v64"], segaMD: ["md", "gen", "bin"],
    psx: ["chd", "cue", "iso", "pbp"], arcade: ["zip"], psp: ["iso", "cso", "pbp"]
};
const $ = id => document.getElementById(id);
let sources = [];
let games = [];
let busy = false;

function readJSON(key, fallback) {
    try { const value = JSON.parse(localStorage.getItem(key) || "null"); return value ?? fallback; }
    catch { return fallback; }
}
function saveSources() { localStorage.setItem(SOURCE_KEY, JSON.stringify(sources)); }
function saveGames() { localStorage.setItem(GAMES_KEY, JSON.stringify(games.filter(game => !game.local))); }
function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}
function toast(message, error = false) {
    const node = document.createElement("div");
    node.className = `toast${error ? " error" : ""}`;
    node.textContent = message;
    $("toast-container").appendChild(node);
    setTimeout(() => node.remove(), 3600);
}
function initialSources() {
    return SOURCE_DEFAULTS.map(item => ({ ...item, url: item.url || `https://github.com/${item.owner}/${item.repo}`, enabled: true, autoUpdate: true, recursive: true, custom: false, lastUpdated: 0, gameCount: 0, status: "pending" }));
}
function loadState() {
    const saved = readJSON(SOURCE_KEY, null);
    if (!Array.isArray(saved)) sources = initialSources();
    else {
        const initial = initialSources();
        sources = initial.map(item => ({ ...item, ...(saved.find(entry => entry.id === item.id) || {}) }));
        saved.filter(item => item.custom && !sources.some(source => source.id === item.id)).forEach(item => sources.push(item));
    }
    sources.forEach(source => {
        if (source.required) source.enabled = true;
        const canonical = SOURCE_DEFAULTS.find(item => item.id === source.id);
        if (canonical && source.required) {
            source.owner = canonical.owner;
            source.repo = canonical.repo;
            source.branch = canonical.branch;
            source.path = canonical.path || "";
            source.platform = canonical.platform;
            source.extensions = canonical.extensions || undefined;
            source.url = canonical.url || `https://github.com/${canonical.owner}/${canonical.repo}`;
        }
    });
    games = readJSON(GAMES_KEY, []);
    if (!Array.isArray(games)) games = [];
    saveSources();
}
function parseGitHubURL(value) {
    const url = new URL(value);
    if (url.hostname !== "github.com") throw new Error("Use um endereço do GitHub.");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) throw new Error("O link precisa conter usuário e repositório.");
    const parsed = { owner: parts[0], repo: parts[1].replace(/\.git$/i, ""), branch: "", path: "" };
    if (parts[2] === "tree" || parts[2] === "blob") {
        parsed.branch = parts[3] || "";
        parsed.path = parts.slice(4).join("/");
    }
    return parsed;
}
async function githubJSON(url) {
    const response = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
    if (response.status === 403 || response.status === 429) throw new Error("Limite público de consultas do GitHub atingido. Aguarde e tente novamente.");
    if (!response.ok) throw new Error(`GitHub respondeu com erro ${response.status}. Confira se o repositório é público.`);
    return response.json();
}
function detectPlatform(path) {
    const ext = path.split(".").pop().toLowerCase();
    return Object.keys(EXTENSIONS).find(platform => EXTENSIONS[platform].includes(ext)) || null;
}
function supportsSourceFile(path, source) {
    const ext = path.split(".").pop().toLowerCase();
    if (Array.isArray(source.extensions) && source.extensions.length) return source.extensions.includes(ext);
    if (source.platform && source.platform !== "auto") return (EXTENSIONS[source.platform] || []).includes(ext);
    return Boolean(detectPlatform(path));
}
function makeRawURL(owner, repo, branch, path) {
    return `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}
function categoryGuess(name) {
    const value = name.toLowerCase();
    if (/soccer|football|futebol/.test(value)) return "futebol";
    if (/fight|fighter|street|mortal|tekken/.test(value)) return "luta";
    if (/rpg|quest|fantasy|zelda|pokemon/.test(value)) return "rpg";
    if (/race|racing|kart|car/.test(value)) return "corrida";
    if (/adventure|zelda|metroid/.test(value)) return "aventura";
    return "outros";
}
function upsertGame(game) {
    const index = games.findIndex(item => item.id === game.id || (item.sourceId === game.sourceId && item.path === game.path));
    if (index >= 0) games[index] = { ...games[index], ...game };
    else games.push(game);
}
async function updateSource(source) {
    if (busy) return;
    busy = true;
    source.status = "loading";
    render();
    try {
        const repo = await githubJSON(`https://api.github.com/repos/${source.owner}/${source.repo}`);
        const branch = source.branch || repo.default_branch;
        const tree = await githubJSON(`https://api.github.com/repos/${source.owner}/${source.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
        let paths = (tree.tree || []).filter(item => item.type === "blob").map(item => item.path);
        if (source.path) paths = paths.filter(path => path === source.path || path.startsWith(`${source.path.replace(/\/$/, "")}/`));
        if (!source.recursive && source.path) paths = paths.filter(path => !path.slice(source.path.length).replace(/^\//, "").includes("/"));
        paths = paths.filter(path => supportsSourceFile(path, source) && !/(^|\/)(node_modules|vendor|dist|build|\.git)(\/|$)/i.test(path));
        paths = paths.filter(path => !/(^|\/)(readme|license|changelog|contributing)\.(md|txt)$/i.test(path)).slice(0, 1200);
        let imported = 0;
        for (const path of paths) {
            const detected = detectPlatform(path);
            const platform = source.platform && source.platform !== "auto" ? source.platform : detected;
            if (!EXTENSIONS[platform]) continue;
            const filename = path.split("/").pop();
            const name = filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
            upsertGame({
                id: `${source.id}-${path}`, name, url: makeRawURL(source.owner, source.repo, branch, path), type: platform,
                category: source.category && source.category !== "auto" ? source.category : categoryGuess(name),
                source: source.name, sourceId: source.id, path, origin: source.custom ? "github" : "native", local: false
            });
            imported++;
        }
        source.branch = branch;
        source.gameCount = imported;
        source.lastUpdated = Date.now();
        source.status = "active";
        source.lastError = "";
        saveSources(); saveGames();
        toast(`${source.name}: ${imported} jogo(s) encontrado(s).`);
    } catch (error) {
        source.status = "error";
        source.lastError = error.message;
        saveSources();
        toast(`${source.name}: ${error.message}`, true);
    } finally { busy = false; render(); }
}
function removeSource(source) {
    if (!source.custom) { toast("Fontes originais não podem ser removidas. Você pode desativá-las.", true); return; }
    if (!confirm(`Remover a fonte “${source.name}” e os jogos importados por ela?`)) return;
    sources = sources.filter(item => item.id !== source.id);
    games = games.filter(game => game.sourceId !== source.id);
    saveSources(); saveGames(); render(); toast("Fonte removida.");
}
function render() {
    $("total-sources").textContent = sources.length;
    $("active-sources").textContent = sources.filter(source => source.enabled).length;
    $("total-imported-games").textContent = games.filter(game => game.sourceId).length;
    const list = $("source-list");
    if (!sources.length) { list.innerHTML = '<div class="empty-state">Nenhuma fonte cadastrada.</div>'; return; }
    list.innerHTML = sources.map(source => {
        const count = games.filter(game => game.sourceId === source.id).length;
        const status = source.status === "error" ? "Erro" : source.status === "loading" ? "Atualizando" : source.enabled ? (source.required ? "Obrigatória" : "Ativa") : "Desativada";
        const statusClass = source.status === "error" ? "error" : source.enabled ? "" : "disabled";
        return `<article class="source-card"><div class="source-card-icon">◈</div><div class="source-card-info"><h3>${escapeHTML(source.name)}</h3><p><a href="${escapeHTML(source.url)}" target="_blank" rel="noopener">${escapeHTML(source.url)}</a></p><div class="source-card-meta"><span>${escapeHTML(source.platform || "auto").toUpperCase()}</span><span>${count} jogos salvos</span><span>${source.custom ? "Personalizada" : "Original"}</span>${source.path ? `<span>/${escapeHTML(source.path)}</span>` : ""}</div>${source.lastError ? `<p class="source-error">${escapeHTML(source.lastError)}</p>` : ""}<span class="source-status ${statusClass}">${status}</span>${source.lastUpdated ? `<small>Última atualização: ${new Date(source.lastUpdated).toLocaleString("pt-BR")}</small>` : ""}</div><div class="source-card-actions"><button class="source-action-button" data-refresh="${escapeHTML(source.id)}" ${busy ? "disabled" : ""}>↻ Atualizar</button>${source.required ? "" : `<button class="source-action-button" data-toggle="${escapeHTML(source.id)}">${source.enabled ? "Desativar" : "Ativar"}</button>`}${source.custom ? `<button class="source-action-button danger" data-delete="${escapeHTML(source.id)}">Remover</button>` : ""}</div></article>`;
    }).join("");
}
async function refreshAll() {
    if (busy) return;
    const enabled = sources.filter(source => source.enabled);
    for (const source of enabled) await updateSource(source);
}
function exportSources() {
    const payload = { format: "FlashManiaSources", version: 1, exportedAt: new Date().toISOString(), sources, games: games.filter(game => game.sourceId) };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "flashmania-fontes-backup.json"; anchor.click();
    URL.revokeObjectURL(url); toast("Backup das fontes exportado.");
}
async function importSources(file) {
    if (!file) return;
    try {
        const data = JSON.parse(await file.text());
        if (data.format !== "FlashManiaSources" || !Array.isArray(data.sources)) throw new Error("Arquivo de backup inválido.");
        const map = new Map(sources.map(source => [source.id, source]));
        data.sources.forEach(source => map.set(source.id, source));
        sources = [...map.values()];
        sources.forEach(source => { if (source.required) source.enabled = true; });
        if (Array.isArray(data.games)) data.games.forEach(upsertGame);
        saveSources(); saveGames(); render(); toast("Backup de fontes restaurado.");
    } catch (error) { toast(error.message, true); }
    $("import-sources-file").value = "";
}
async function autoUpdateSavedSources() {
    const interval = 6 * 60 * 60 * 1000;
    const due = sources.filter(source => source.enabled && source.autoUpdate && (!source.lastUpdated || Date.now() - source.lastUpdated >= interval));
    for (const source of due) await updateSource(source);
}
function init() {
    loadState();
    render();
    $("add-source-form").addEventListener("submit", async event => {
        event.preventDefault();
        try {
            const parsed = parseGitHubURL($("source-url").value.trim());
            const duplicate = sources.some(source => source.owner.toLowerCase() === parsed.owner.toLowerCase() && source.repo.toLowerCase() === parsed.repo.toLowerCase() && (source.path || "") === parsed.path);
            if (duplicate) throw new Error("Essa fonte já está cadastrada.");
            const source = {
                id: `custom-${crypto.randomUUID()}`, name: $("source-name").value.trim() || `${parsed.owner}/${parsed.repo}`,
                owner: parsed.owner, repo: parsed.repo, branch: $("source-branch").value.trim() || parsed.branch, path: parsed.path,
                url: $("source-url").value.trim(), platform: $("source-platform").value, category: $("source-category").value,
                enabled: true, autoUpdate: $("source-auto-update").checked, recursive: $("source-recursive").checked,
                custom: true, origin: "github", lastUpdated: 0, gameCount: 0, status: "pending"
            };
            sources.push(source); saveSources(); event.target.reset(); $("source-auto-update").checked = true; $("source-recursive").checked = true;
            render(); await updateSource(source);
        } catch (error) { toast(error.message || "Não foi possível adicionar a fonte.", true); }
    });
    $("source-list").addEventListener("click", async event => {
        const button = event.target.closest("button"); if (!button) return;
        const source = sources.find(item => item.id === (button.dataset.refresh || button.dataset.toggle || button.dataset.delete));
        if (!source) return;
        if (button.dataset.refresh) await updateSource(source);
        if (button.dataset.toggle) {
            if (source.required) { toast("Esta fonte é obrigatória e não pode ser desativada.", true); return; }
            source.enabled = !source.enabled; saveSources(); render(); if (source.enabled) await updateSource(source);
        }
        if (button.dataset.delete) removeSource(source);
    });
    $("refresh-all-sources").addEventListener("click", refreshAll);
    $("export-sources").addEventListener("click", exportSources);
    $("import-sources-file").addEventListener("change", event => importSources(event.target.files[0]));
    $("reset-sources").addEventListener("click", () => {
        if (!confirm("Restaurar a lista de fontes originais? Suas fontes personalizadas serão mantidas.")) return;
        const custom = sources.filter(source => source.custom);
        sources = [...initialSources(), ...custom.filter(source => !SOURCE_DEFAULTS.some(item => item.owner === source.owner && item.repo === source.repo && (item.path || "") === (source.path || "")))];
        saveSources(); render(); toast("Fontes originais restauradas.");
    });
    $("menu-toggle").addEventListener("click", () => $("sidebar").classList.toggle("open"));
    autoUpdateSavedSources();
}
document.addEventListener("DOMContentLoaded", init);
