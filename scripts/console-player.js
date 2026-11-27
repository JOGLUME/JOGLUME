(() => {
"use strict";

const SYSTEMS = {
    psx: {
        key: "psx", label: "PlayStation 1", heading: "PlayStation 1", short: "PS1", core: "psx",
        extensions: ["chd", "cue", "iso", "pbp"], recentKey: "fm_psx_recent_v1", maxFileSize: 1024 * 1024 * 1024,
        description: "Carregue jogos de PlayStation em CHD, ISO, PBP ou CUE. Para CUE local, use um CHD/ISO ou forneça um link CUE com os arquivos BIN na mesma pasta."
    },
    psp: {
        key: "psp", label: "PlayStation Portable", heading: "PlayStation Portable", short: "PSP", core: "psp",
        extensions: ["iso", "cso", "pbp"], recentKey: "fm_psp_recent_v1", maxFileSize: 2048 * 1024 * 1024,
        description: "Carregue jogos PSP em ISO, CSO ou EBOOT.PBP. O PSP exige threads e isolamento de origem cruzada (COOP/COEP)."
    }
};

const SYSTEM = SYSTEMS[document.body.dataset.system];
const DATA_PATH = "https://cdn.emulatorjs.org/stable/data/";
const SOURCES_KEY = "fm_sources_v3";
const GAMES_KEY = "fm_games_v3";
const $ = selector => document.querySelector(selector);
let activeGame = null;
let activeObjectUrl = null;
let loaderScript = null;
let recentGames = readJSON(SYSTEM.recentKey, []);

function readJSON(key, fallback) {
    try { const value = JSON.parse(localStorage.getItem(key) || "null"); return value ?? fallback; }
    catch { return fallback; }
}
function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}
function toast(message, isError = false) {
    const node = document.createElement("div");
    node.className = `toast${isError ? " error" : ""}`;
    node.textContent = message;
    $("#toast-container").appendChild(node);
    setTimeout(() => node.remove(), 4200);
}
function focusPlayer() {
    const player = $(".player-card");
    if (!player) return;
    requestAnimationFrame(() => player.scrollIntoView({ behavior: "smooth", block: "start" }));
}

function setStatus(message) { $("#player-state").textContent = message.toUpperCase(); }
function getGames() {
    return readJSON(GAMES_KEY, []).filter(game => game.type === SYSTEM.key && game.url);
}
function getSources() {
    return readJSON(SOURCES_KEY, []).filter(source => source.platform === SYSTEM.key);
}
function renderSources() {
    const sources = getSources();
    const box = $("#system-sources");
    if (!sources.length) {
        box.innerHTML = `<div class="empty-state">Nenhuma fonte ${SYSTEM.short} cadastrada. Você pode adicionar repositórios compatíveis no <a href="fontes.html">gerenciador de fontes</a>.</div>`;
        return;
    }
    box.innerHTML = sources.map(source => {
        const count = getGames().filter(game => game.sourceId === source.id).length;
        const status = source.status === "error" ? "Erro na última atualização" : source.lastUpdated ? `Atualizada em ${new Date(source.lastUpdated).toLocaleString("pt-BR")}` : "Aguardando primeira importação";
        return `<article class="source-card"><div class="source-card-icon">◈</div><div class="source-card-info"><h3>${escapeHTML(source.name)}</h3><p><a href="${escapeHTML(source.url || "#")}" target="_blank" rel="noopener">Abrir repositório</a></p><div class="source-card-meta"><span>${count} jogo(s)</span><span>${source.required ? "Fonte original" : "Fonte personalizada"}</span></div><small>${escapeHTML(status)}</small>${source.lastError ? `<small>${escapeHTML(source.lastError)}</small>` : ""}</div></article>`;
    }).join("");
}
function normalizeSearch(value) {
    return String(value || "").toLocaleLowerCase("pt-BR").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}
function renderLibrary() {
    const allGames = getGames();
    const box = $("#system-games");
    const query = normalizeSearch($("#system-game-search")?.value || "");
    const games = allGames.filter(game => normalizeSearch([game.name, game.source, game.path].join(" ")).includes(query));
    if (!allGames.length) {
        box.innerHTML = `<div class="empty-state">Nenhum jogo ${SYSTEM.short} foi importado ainda. Adicione uma fonte compatível ou carregue um arquivo local.</div>`;
        box._games = [];
        return;
    }
    if (!games.length) {
        box.innerHTML = '<div class="empty-state">Nenhum jogo encontrado com esse termo.</div>';
        box._games = [];
        return;
    }
    box.innerHTML = games.map((game, index) => `<article class="rom-item"><div><strong title="${escapeHTML(game.name)}">${escapeHTML(game.name)}</strong><small>${escapeHTML(game.source || SYSTEM.label)} · ${escapeHTML(game.path || "")}</small></div><button type="button" data-library-game="${index}">Jogar</button></article>`).join("");
    box._games = games;
}
function renderRecent() {
    const box = $("#recent-list");
    if (!recentGames.length) { box.innerHTML = '<div class="empty-state">Seus jogos recentes aparecerão aqui.</div>'; return; }
    box.innerHTML = recentGames.map((game, index) => `<article class="recent-item"><span class="recent-symbol">🎮</span><div><strong title="${escapeHTML(game.name)}">${escapeHTML(game.name)}</strong><small>${escapeHTML(game.source || SYSTEM.short)}</small></div><button type="button" data-recent-game="${index}">Jogar</button></article>`).join("");
}
function addRecent(game) {
    const savedUrl = game.persistUrl || game.url;
    recentGames = [{ name: game.name, url: savedUrl, source: game.source || SYSTEM.label }, ...recentGames.filter(item => item.url !== savedUrl)].slice(0, 10);
    localStorage.setItem(SYSTEM.recentKey, JSON.stringify(recentGames));
    renderRecent();
}
function stopEmulator(preserveUrl = null) {
    if (loaderScript) { loaderScript.remove(); loaderScript = null; }
    $("#game").innerHTML = "";
    if (activeObjectUrl && activeObjectUrl.startsWith("blob:") && activeObjectUrl !== preserveUrl) URL.revokeObjectURL(activeObjectUrl);
    activeObjectUrl = null;
    ["EJS_player", "EJS_gameUrl", "EJS_core", "EJS_gameName", "EJS_pathtodata", "EJS_threads"].forEach(key => { window[key] = undefined; });
}
function startEmulator(game) {
    if (!game || !game.url) return;
    const sourceUrl = game.url;
    if (!sourceUrl.startsWith("blob:") && extensionOf(sourceUrl) !== "cue" && new URL(sourceUrl, location.href).origin !== location.origin) {
        game = { ...game, url: `/api/rom-proxy?url=${encodeURIComponent(sourceUrl)}`, persistUrl: `/api/rom-proxy?url=${encodeURIComponent(sourceUrl)}` };
    }
    if (SYSTEM.key === "psp" && !window.crossOriginIsolated) {
        setStatus("ISOLAMENTO NECESSÁRIO");
        $("#psp-isolation-warning").hidden = false;
        toast("O navegador não recebeu o isolamento COOP/COEP necessário ao PSP. Atualize a página e tente novamente.", true);
        return;
    }
    stopEmulator(game.url);
    activeGame = game;
    activeObjectUrl = game.url.startsWith("blob:") ? game.url : null;
    $("#screen-placeholder").hidden = true;
    $("#game-title").textContent = game.name.toUpperCase();
    setStatus("CARREGANDO ROM");
    addRecent(game);
    focusPlayer();
    window.EJS_player = "#game";
    window.EJS_core = SYSTEM.core;
    window.EJS_gameUrl = game.url;
    window.EJS_gameName = game.name;
    window.EJS_pathtodata = DATA_PATH;
    window.EJS_color = "#ff7043";
    window.EJS_startOnLoaded = true;
    window.EJS_language = "pt-BR";
    window.EJS_backgroundColor = "#08090d";
    window.EJS_gameID = `flashmania-${SYSTEM.key}`;
    window.JoglumeSaveCloud?.configureEmulator(game, SYSTEM.key);
    if (SYSTEM.key === "psp") window.EJS_threads = true;
    loaderScript = document.createElement("script");
    loaderScript.src = `${DATA_PATH}loader.js`;
    loaderScript.async = true;
    loaderScript.crossOrigin = "anonymous";
    loaderScript.onload = () => setStatus("EMULADOR INICIADO");
    loaderScript.onerror = () => { setStatus("ERRO AO INICIAR"); toast("Não foi possível carregar o EmulatorJS. Verifique sua conexão.", true); };
    document.body.appendChild(loaderScript);
}
function extensionOf(value) {
    try { return new URL(value, location.href).pathname.split(".").pop().toLowerCase(); }
    catch { return ""; }
}
function loadDirectURL(value) {
    const url = value.trim();
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error("Informe uma URL válida."); }
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("Use um endereço HTTP ou HTTPS.");
    const extension = extensionOf(parsed.href);
    if (!SYSTEM.extensions.includes(extension)) throw new Error(`Este console aceita: ${SYSTEM.extensions.map(ext => "." + ext).join(", ")}.`);
    const filename = decodeURIComponent(parsed.pathname.split("/").pop() || SYSTEM.label);
    startEmulator({ name: filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "), url: parsed.href, persistUrl: parsed.href, source: "Link direto" });
}
function loadLocalFile(file) {
    if (!file) return;
    const extension = file.name.split(".").pop().toLowerCase();
    if (!SYSTEM.extensions.includes(extension)) { toast(`Formato inválido. Aceitos: ${SYSTEM.extensions.map(ext => "." + ext).join(", ")}.`, true); return; }
    if (SYSTEM.key === "psx" && extension === "cue") { toast("Um CUE local depende de arquivos BIN separados. Use CHD/ISO/PBP localmente ou informe o link direto do CUE com os BINs na mesma pasta.", true); return; }
    if (file.size > SYSTEM.maxFileSize) { toast(`O arquivo ultrapassa o limite de ${Math.round(SYSTEM.maxFileSize / 1024 / 1024)} MB.`, true); return; }
    const url = URL.createObjectURL(file);
    $("#file-name").textContent = file.name;
    startEmulator({ name: file.name.replace(/\.[^.]+$/, ""), url, source: "Arquivo local" });
}
function init() {
    $("#page-title").textContent = SYSTEM.heading;
    $("#system-name").textContent = SYSTEM.short;
    $("#file-format-note").textContent = `Formatos aceitos: ${SYSTEM.extensions.map(ext => "." + ext).join(", ")}.`;
    $("#rom-file").accept = SYSTEM.extensions.map(ext => "." + ext).join(",");
    $("#menu-toggle").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
    $("#system-game-search")?.addEventListener("input", renderLibrary);
    $("#clear-system-search")?.addEventListener("click", () => { $("#system-game-search").value = ""; renderLibrary(); $("#system-game-search").focus(); });
    $("#rom-file").addEventListener("change", event => loadLocalFile(event.target.files[0]));
    $("#url-form").addEventListener("submit", event => { event.preventDefault(); try { loadDirectURL($("#rom-url").value); } catch (error) { toast(error.message, true); } });
    $("#system-games").addEventListener("click", event => { const button = event.target.closest("[data-library-game]"); if (!button) return; const game = $("#system-games")._games?.[Number(button.dataset.libraryGame)]; if (game) startEmulator(game); });
    $("#recent-list").addEventListener("click", event => { const button = event.target.closest("[data-recent-game]"); if (!button) return; const game = recentGames[Number(button.dataset.recentGame)]; if (!game) return; if (game.url.startsWith("blob:")) { toast("Selecione novamente o arquivo local: arquivos locais não permanecem disponíveis após atualizar a página.", true); return; } startEmulator(game); });
    $("#refresh-library").addEventListener("click", () => { renderSources(); renderLibrary(); toast("Biblioteca atualizada com os dados salvos neste navegador."); });
    $("#fullscreen").addEventListener("click", async () => { try { if (!document.fullscreenElement) await $("#screen-wrap").requestFullscreen(); else await document.exitFullscreen(); } catch { toast("Não foi possível ativar a tela cheia.", true); } });
    $("#reset-game").addEventListener("click", () => { if (activeGame) startEmulator(activeGame); else toast("Carregue uma ROM primeiro.", true); });
    $("#clear-recent").addEventListener("click", () => { recentGames = []; localStorage.removeItem(SYSTEM.recentKey); renderRecent(); });
    if (SYSTEM.key === "psp") {
        $("#psp-isolation-warning").hidden = Boolean(window.crossOriginIsolated);
        if (!window.crossOriginIsolated) setStatus("SERVIDOR ESPECIAL NECESSÁRIO");
    }
    renderSources(); renderLibrary(); renderRecent();
    const pendingKey = `fm_pending_${SYSTEM.key}`;
    const pending = readJSON(pendingKey, null);
    if (pending && (SYSTEM.key !== "psp" || window.crossOriginIsolated)) {
        localStorage.removeItem(pendingKey);
        startEmulator(pending);
    }
}
document.addEventListener("DOMContentLoaded", init);
})();
