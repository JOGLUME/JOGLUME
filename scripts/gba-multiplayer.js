"use strict";

(() => {
    const $ = selector => document.querySelector(selector);
    const frame = $("#mgba-frame");
    const status = $("#multi-status");
    const loading = $("#multi-loading");
    const romForm = $("#multi-rom-form");
    const romInput = $("#multi-rom-url");
    const romFeedback = $("#multi-rom-feedback");
    const openLink = $("#multi-open");
    let currentRomUrl = "";

    function setStatus(message) {
        status.textContent = message.toUpperCase();
    }

    function toast(message, type = "success") {
        const item = document.createElement("div");
        item.className = `toast${type === "error" ? " error" : ""}`;
        item.textContent = message;
        $("#toast-container").appendChild(item);
        window.setTimeout(() => item.remove(), 3600);
    }

    $("#menu-toggle").addEventListener("click", () => {
        $("#sidebar").classList.toggle("open");
    });

    frame.addEventListener("load", () => {
        loading.hidden = true;
        setStatus("PÁGINA DO EMULADOR CARREGADA");
    });

    frame.addEventListener("error", () => {
        loading.hidden = true;
        setStatus("FALHA AO CARREGAR");
        toast("Não foi possível carregar o emulador externo. Tente abrir em uma nova aba.", "error");
    });

    function buildEmulatorUrl() {
        const url = new URL("https://spuds0588.github.io/mgba-splitscreen/");
        url.searchParams.set("players", "1");
        if (currentRomUrl) url.searchParams.set("rom", currentRomUrl);
        return url.toString();
    }

    romForm.addEventListener("submit", event => {
        event.preventDefault();
        const value = romInput.value.trim();
        try {
            const parsed = new URL(value);
            if (!/^https?:$/.test(parsed.protocol)) throw new Error("URL inválida");
            if (!/\.gba(?:$|[?#])/i.test(parsed.href)) {
                romFeedback.textContent = "A URL precisa apontar para um arquivo .gba.";
                return;
            }
            currentRomUrl = parsed.href;
            const target = buildEmulatorUrl();
            frame.src = target;
            openLink.href = target;
            loading.hidden = false;
            romFeedback.textContent = "Link enviado ao emulador. Se o servidor não permitir CORS, o carregamento será recusado pelo navegador.";
            setStatus("CARREGANDO ROM PELO LINK");
        } catch {
            romFeedback.textContent = "Informe um endereço HTTP ou HTTPS válido.";
        }
    });

    $("#multi-reload").addEventListener("click", () => {
        loading.hidden = false;
        setStatus("RECARREGANDO");
        frame.src = `${buildEmulatorUrl()}&reload=${Date.now()}`;
    });

    $("#multi-fullscreen").addEventListener("click", async () => {
        try {
            if (!document.fullscreenElement) {
                await $("#multi-frame-wrap").requestFullscreen();
            } else {
                await document.exitFullscreen();
            }
        } catch {
            toast("O navegador não permitiu ativar a tela cheia.", "error");
        }
    });
})();
