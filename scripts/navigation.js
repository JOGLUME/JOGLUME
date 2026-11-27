(() => {
  "use strict";
  const path = location.pathname.split("/").filter(Boolean).pop() || "index.html";
  const inPages = location.pathname.includes("/paginas/");
  const home = inPages ? "../index.html" : "index.html";
  const pageItems = [
    ["gba.html","🕹️","Game Boy Advance"],
    ["gba-multiplayer.html","👥","GBA Multiplayer"],
    ["snes.html","🟣","Super Nintendo"],
    ["megadrive.html","🔵","Mega Drive"],
    ["psx.html","💿","PlayStation 1"],
    ["psp.html","🎮","PlayStation Portable"],
    ["ps2.html","💿","PlayStation 2"]
  ];
  const pageNames = {
    "gba.html":"Game Boy Advance","gba-multiplayer.html":"GBA Multiplayer",
    "snes.html":"Super Nintendo","megadrive.html":"Mega Drive",
    "psx.html":"PlayStation 1","psp.html":"PlayStation Portable",
    "ps2.html":"PlayStation 2","fontes.html":"Gerenciador de fontes"
  };
  function link(href, icon, label, active) {
    return '<a class="nav-item'+(active?' active':'')+'" href="'+href+'"'+(active?' aria-current="page"':'')+'><span aria-hidden="true">'+icon+'</span>'+label+'</a>';
  }
  function setup() {
    const skip = document.createElement("a");
    skip.className = "skip-link";
    skip.href = "#conteudo-principal";
    skip.textContent = "Pular para o conteúdo";
    document.body.prepend(skip);
    const sidebar = document.getElementById("sidebar");
    const logo = sidebar?.querySelector(".logo");
    if (logo && logo.tagName !== "A") {
      const anchor = document.createElement("a");
      anchor.className = "logo";
      anchor.href = home;
      anchor.setAttribute("aria-label","Joglume — voltar ao início");
      logo.replaceWith(anchor);
      while (logo.firstChild) anchor.appendChild(logo.firstChild);
    }
    const brand = document.querySelector(".breadcrumb > span:first-child");
    if (brand && brand.tagName !== "A") {
      const anchor = document.createElement("a");
      anchor.className = "breadcrumb-brand";
      anchor.href = home;
      anchor.textContent = brand.textContent.trim();
      anchor.setAttribute("aria-label","Voltar para a página inicial do Joglume");
      brand.replaceWith(anchor);
    }
    const nav = sidebar?.querySelector(".navigation");
    if (nav && inPages) {
      const items = pageItems.map(([file,icon,label]) => link(file,icon,label,path===file)).join("");
      const sourceActive = path === "fontes.html";
      nav.setAttribute("aria-label","Navegação principal");
      nav.innerHTML =
        '<div class="nav-section"><span class="nav-title">NAVEGAÇÃO</span>'+
        link("../index.html","⌂","Início",false)+
        link("../index.html#biblioteca","▤","Biblioteca",false)+
        link("fontes.html","◈","Gerenciador de fontes",sourceActive)+
        '</div><div class="nav-section"><span class="nav-title">EMULADORES</span>'+items+'</div>';
    } else if (nav) {
      nav.setAttribute("aria-label","Navegação principal");
    }
    const main = document.querySelector(".main-content");
    if (main && !main.id) main.id = "conteudo-principal";
    const page = document.querySelector(".page.active");
    if (page && !page.id && path !== "index.html") page.id = "conteudo-pagina";
    const toggle = document.getElementById("menu-toggle");
    toggle?.setAttribute("aria-label","Abrir ou fechar menu");
    if (!inPages && location.hash === "#biblioteca") {
      window.addEventListener("load", () => {
        document.querySelector('[data-page="library"]')?.click();
      }, { once: true });
    }
    document.querySelectorAll('a[target="_blank"]').forEach(a => {
      if (!a.rel.includes("noopener")) a.rel = (a.rel+" noopener noreferrer").trim();
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded",setup,{once:true});
  else setup();
})();