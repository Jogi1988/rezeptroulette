// ==UserScript==
// @name         RezeptRoulette Import
// @namespace    https://jo-gis.de
// @version      1.2
// @description  Rezepte direkt in RezeptRoulette importieren – Button auf Rezept-Webseiten (SPA-kompatibel, Übersichtsseiten)
// @author       Jochen Weiland
// @match        *://*.hellofresh.de/*
// @match        *://*.hellofresh.at/*
// @match        *://*.hellofresh.ch/*
// @match        *://*.chefkoch.de/*
// @match        *://*.lecker.de/*
// @match        *://*.eatsmarter.de/*
// @match        *://*.kitchenstories.com/*
// @match        *://*.gutekueche.de/*
// @match        *://*.kochbar.de/*
// @match        *://*.springlane.de/*
// @match        *://*.rewe.de/*
// @match        *://*.lidl-kochen.de/*
// @match        *://*.simply-yummy.de/*
// @match        *://*.zambeza.de/*
// @grant        none
// @icon         https://jo-gis.de/favicon.ico
// @homepageURL  https://jo-gis.de
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const APP_URL = 'https://jo-gis.de';

  // ── Rezept-URL-Muster ──────────────────────────────────────────────
  const RECIPE_PATTERNS = [
    /hellofresh\.\w+\/recipes\/[a-z0-9-]+-[a-f0-9]{10,}/,
    /chefkoch\.de\/rezepte\/\d/,
    /lecker\.de\/rezepte\//,
    /eatsmarter\.de\/rezepte\//,
    /kitchenstories\.com\/.*\/rezepte\//,
    /gutekueche\.de\/rezept\//,
    /kochbar\.de\/rezept\//,
    /springlane\.de\/magazin\/rezeptideen\//,
    /rewe\.de\/rezepte\//,
    /lidl-kochen\.de\/rezeptwelt\//,
    /simply-yummy\.de\/rezepte\//,
    /zambeza\.de\/rezepte\//,
  ];

  function isRecipeUrl(url) {
    return RECIPE_PATTERNS.some(p => p.test(url));
  }

  function isCurrentPageRecipe() {
    return isRecipeUrl(window.location.href);
  }

  // ── Shared Styles ──────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    .rr-fab {
      position: fixed; bottom: 24px; right: 24px; z-index: 999999;
      background: #067A46; color: #fff; padding: 12px 20px; border-radius: 28px;
      font-size: 15px; font-weight: 600;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,.3);
      transition: transform 0.15s, box-shadow 0.15s; user-select: none;
    }
    .rr-fab:hover { transform: scale(1.05); box-shadow: 0 6px 20px rgba(0,0,0,.4); }

    .rr-card-btn {
      position: absolute; top: 8px; right: 8px; z-index: 9999;
      background: #067A46; color: #fff; border: none; border-radius: 50%;
      width: 36px; height: 36px; font-size: 18px; line-height: 36px; text-align: center;
      cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.35);
      transition: transform 0.15s, box-shadow 0.15s; user-select: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    .rr-card-btn:hover { transform: scale(1.15); box-shadow: 0 4px 12px rgba(0,0,0,.45); }
    .rr-card-btn::after {
      content: 'In RezeptRoulette importieren';
      position: absolute; right: 110%; top: 50%; transform: translateY(-50%);
      background: rgba(0,0,0,.8); color: #fff; padding: 4px 10px; border-radius: 6px;
      font-size: 12px; white-space: nowrap; pointer-events: none; opacity: 0;
      transition: opacity 0.2s;
    }
    .rr-card-btn:hover::after { opacity: 1; }
  `;
  document.head.appendChild(style);

  // ── Floating FAB (auf Einzelrezept-Seiten) ─────────────────────────
  let fab = null;

  function createFab() {
    if (fab) return;
    fab = document.createElement('div');
    fab.className = 'rr-fab';
    fab.textContent = '🍽️ RezeptRoulette';
    fab.addEventListener('click', () => {
      window.open(APP_URL + '/#import=' + encodeURIComponent(window.location.href), '_blank');
    });
    document.body.appendChild(fab);
  }

  function removeFab() {
    if (fab) { fab.remove(); fab = null; }
  }

  // ── Inline-Buttons auf Rezept-Karten (Übersichtsseiten) ───────────
  const PROCESSED_ATTR = 'data-rr-processed';

  function openImport(url, e) {
    e.preventDefault();
    e.stopPropagation();
    window.open(APP_URL + '/#import=' + encodeURIComponent(url), '_blank');
  }

  function injectCardButtons() {
    // Finde alle <a>-Links die auf Rezeptseiten zeigen
    const links = document.querySelectorAll('a[href*="/recipes/"]');
    for (const link of links) {
      const href = link.href;
      if (!href || !isRecipeUrl(href)) continue;
      if (link.hasAttribute(PROCESSED_ATTR)) continue;
      link.setAttribute(PROCESSED_ATTR, '1');

      // Finde den nächsten positionierbaren Container
      // (das Eltern-Element der Karte oder den Link selbst)
      let container = link;
      // Stelle sicher, dass der Container position:relative hat
      const cs = getComputedStyle(container);
      if (cs.position === 'static') {
        container.style.position = 'relative';
      }

      const btn = document.createElement('button');
      btn.className = 'rr-card-btn';
      btn.textContent = '🍽️';
      btn.addEventListener('click', (e) => openImport(href, e));
      container.appendChild(btn);
    }
  }

  function removeCardButtons() {
    document.querySelectorAll('.rr-card-btn').forEach(b => b.remove());
    document.querySelectorAll('[' + PROCESSED_ATTR + ']').forEach(el => el.removeAttribute(PROCESSED_ATTR));
  }

  // ── Seiten-Check & Update ──────────────────────────────────────────
  function updatePage() {
    if (isCurrentPageRecipe()) {
      createFab();
      removeCardButtons();
    } else {
      removeFab();
      injectCardButtons();
    }
  }

  // ── MutationObserver für dynamisch geladene Inhalte ────────────────
  let debounceTimer;
  const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (!isCurrentPageRecipe()) {
        injectCardButtons();
      }
    }, 300);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Sofort prüfen
  updatePage();

  // pushState/replaceState abfangen (SPA-Navigation)
  const origPushState = history.pushState;
  const origReplaceState = history.replaceState;
  history.pushState = function () {
    origPushState.apply(this, arguments);
    setTimeout(updatePage, 200);
  };
  history.replaceState = function () {
    origReplaceState.apply(this, arguments);
    setTimeout(updatePage, 200);
  };
  window.addEventListener('popstate', () => setTimeout(updatePage, 200));
})();
