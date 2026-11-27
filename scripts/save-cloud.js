(() => {
    const API = "/api/save-cloud";
    let session = null;
    let ready = null;

    function gameId(game, platform) {
        const source = String(game && (game.id || game.persistUrl || (game.url && !game.url.startsWith("blob:") ? game.url : "") || game.name) || "game");
        const input = String(platform || (game && game.type) || "unknown") + "|" + source;
        let hash = 2166136261;
        for (let i = 0; i < input.length; i++) { hash ^= input.charCodeAt(i); hash = Math.imul(hash, 16777619); }
        return "jgl_" + (hash >>> 0).toString(16).padStart(8, "0");
    }

    async function getSession() {
        if (ready) return ready;
        ready = fetch(API + "/session", { credentials: "same-origin", cache: "no-store" })
            .then(response => response.json()).then(data => { session = data; return data; }).catch(() => null);
        return ready;
    }

    async function exportSaves() {
        const response = await fetch(API + "/export", { credentials: "same-origin", cache: "no-store" });
        if (!response.ok) throw new Error("Não foi possível exportar os saves.");
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement("a");
        link.href = url;
        link.download = "joglume-saves-" + new Date().toISOString().slice(0, 10) + ".zip";
        document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    }

    function escapeHTML(value) {
        return String(value == null ? "" : value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
    }
    function formatBytes(bytes) {
        return bytes < 1024 ? bytes + " B" : bytes < 1048576 ? (bytes / 1024).toFixed(1) + " KB" : (bytes / 1048576).toFixed(1) + " MB";
    }

    function loadGoogleIdentity(clientId) {
        if (window.google && window.google.accounts && window.google.accounts.id) return initializeGoogle(clientId);
        if (document.querySelector("script[data-google-identity]")) return;
        const script = document.createElement("script");
        script.src = "https://accounts.google.com/gsi/client";
        script.async = true; script.defer = true; script.dataset.googleIdentity = "true";
        script.onload = () => initializeGoogle(clientId);
        document.head.appendChild(script);
    }

    function initializeGoogle(clientId) {
        const target = document.querySelector("#google-signin-button");
        if (!target || !window.google || !window.google.accounts || !window.google.accounts.id || target.dataset.ready) return;
        target.dataset.ready = "true";
        window.google.accounts.id.initialize({
            client_id: clientId,
            callback: async response => {
                const result = await fetch(API + "/google", {
                    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ credential: response.credential })
                });
                const data = await result.json();
                if (!result.ok) { const status = document.querySelector("#save-cloud-status"); if (status) status.textContent = data.error || "Falha no login Google."; return; }
                ready = null; await renderPanel();
            }
        });
        window.google.accounts.id.renderButton(target, { theme: "filled_black", size: "large", shape: "pill", text: "continue_with", locale: "pt-BR" });
    }

    async function renderPanel() {
        const status = document.querySelector("#save-cloud-status");
        if (!status) return;
        const current = await getSession();
        if (!current) { status.textContent = "Não foi possível conectar ao Save Cloud. O armazenamento local continua ativo."; return; }
        status.textContent = current.identity === "google"
            ? "Conectado com Google" + (current.email ? " · " + current.email : "")
            : "Modo visitante ativo · vinculado a este navegador.";
        const googleArea = document.querySelector("#save-cloud-google");
        if (googleArea) {
            if (!current.googleConfigured) googleArea.innerHTML = '<p class="save-cloud-note">Login Google aguardando configuração do administrador.</p>';
            else { googleArea.innerHTML = '<div id="google-signin-button"></div>'; loadGoogleIdentity(current.googleClientId); }
        }
        const exportButton = document.querySelector("#save-cloud-export");
        if (exportButton) {
            exportButton.disabled = false;
            exportButton.onclick = async () => {
                exportButton.disabled = true;
                try { await exportSaves(); } catch (error) { status.textContent = error.message; }
                finally { exportButton.disabled = false; }
            };
        }
        const list = document.querySelector("#save-cloud-list");
        if (list) {
            try {
                const response = await fetch(API + "/saves", { credentials: "same-origin", cache: "no-store" });
                const data = await response.json();
                list.innerHTML = data.saves && data.saves.length
                    ? data.saves.map(save => '<div class="save-cloud-row"><div><strong>' + escapeHTML(save.game_name) + '</strong><small>' + escapeHTML(save.platform) + ' · ' + new Date(save.updated_at * 1000).toLocaleString("pt-BR") + ' · ' + formatBytes(save.size) + '</small></div><span>Sincronizado</span></div>').join("")
                    : '<p class="save-cloud-note">Nenhum save sincronizado ainda. Jogue um título compatível e use o salvamento do próprio jogo.</p>';
            } catch { list.innerHTML = '<p class="save-cloud-note">Não foi possível carregar a lista de saves.</p>'; }
        }
    }

    function configureEmulator(game, platform) {
        const id = gameId(game, platform);
        window.EJS_gameID = parseInt(id.slice(4), 16) || 1;
        window.EJS_fixedSaveInterval = 10000;
        window.EJS_onSaveUpdate = async event => {
            if (!event || !event.save) return;
            try {
                await fetch(API + "/saves/" + id, {
                    method: "PUT", credentials: "same-origin",
                    headers: { "Content-Type": "application/octet-stream", "X-Game-Name": encodeURIComponent((game && game.name) || "Jogo"), "X-Game-Platform": platform || (game && game.type) || "unknown", "X-Save-Filename": id + ".srm" },
                    body: event.save
                });
                window.parent.postMessage({ type: "joglume-save-synced", gameId: id }, window.location.origin);
            } catch {}
        };
        window.EJS_onGameStart = async () => {
            const emulator = window.EJS_emulator;
            const manager = emulator && emulator.gameManager;
            if (!manager || !manager.FS) return;
            emulator.pause();
            try {
                const response = await fetch(API + "/saves/" + id + "/file", { credentials: "same-origin", cache: "no-store" });
                if (response.ok) {
                    const bytes = new Uint8Array(await response.arrayBuffer());
                    const path = manager.getSaveFilePath && manager.getSaveFilePath();
                    if (path) {
                        manager.FS.writeFile(path, bytes);
                        await new Promise((resolve, reject) => manager.FS.syncfs(false, error => error ? reject(error) : resolve()));
                        if (manager.loadSaveFiles) manager.loadSaveFiles();
                    }
                }
            } catch {}
            emulator.play();
            window.parent.postMessage({ type: "joglume-emulator-ready", gameId: id }, window.location.origin);
        };
        return id;
    }

    window.JoglumeSaveCloud = { getSession, renderPanel, exportSaves, configureEmulator, gameId };
    document.addEventListener("DOMContentLoaded", renderPanel);
})();