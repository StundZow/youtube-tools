'use strict';

/**
 * YouTube Tools — reglages partages et remise des donnees.
 *
 * Charge avant les autres scripts de contenu, ce module leur expose
 * `window.__yttools` : les reglages (avec suivi des changements en direct) et
 * une fonction `deliver()` unique.
 *
 * Les deux boutons — transcription et export des videos — passent par cette
 * meme fonction : le reglage « enregistrer un fichier » vaut donc forcement
 * pour les deux, sans risque qu'ils divergent un jour.
 */

(() => {
  if (window.__yttools) return;

  const KEY = 'yttoolsSettings';
  const OLD_KEY = 'thumbviewSettings';   // avant le renommage en YouTube Tools
  const DEFAULTS = {
    transcriptButton: true,   // afficher le bouton de transcription
    videosButton: true,       // afficher le bouton d'export des videos
    saveAsFile: false         // false = presse-papiers, true = telechargement
  };

  let current = { ...DEFAULTS };
  const listeners = new Set();

  const settings = {
    get: () => current,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    // Resolu quand les reglages stockes sont lus : les boutons attendent ce
    // signal pour ne pas apparaitre une fraction de seconde avant d'etre
    // masques par un reglage.
    ready: Promise.resolve(current)
  };

  try {
    settings.ready = chrome.storage.local.get([KEY, OLD_KEY])
      .then((stored) => {
        // Le popup migre l'ancienne cle ; tant qu'il n'a pas ete ouvert, on la
        // lit quand meme pour ne pas revenir aux valeurs par defaut.
        const brut = (stored && (stored[KEY] || stored[OLD_KEY])) || {};
        current = { ...DEFAULTS, ...brut };
        return current;
      })
      .catch(() => current);

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[KEY]) return;
      current = { ...DEFAULTS, ...(changes[KEY].newValue || {}) };
      for (const fn of listeners) {
        try { fn(current); } catch { /* un abonne casse n'en penalise pas d'autres */ }
      }
    });
  } catch { /* contexte d'extension indisponible : on garde les valeurs par defaut */ }

  /* ------------------------------------------------- reconnaissance de texte */

  /**
   * YouTube n'etiquette pas ses metadonnees : on les reconnait a ce qu'elles
   * *disent*. Ces motifs servent aussi bien a l'export des videos d'une page
   * qu'aux metadonnees d'une transcription — une seule definition, donc aucun
   * risque qu'elles divergent.
   */
  const RE = {
    // « 379 k vues », « 124 vues », mais aussi « 1,2 M de vues » : au-dela du
    // million, le francais intercale un « de ». Suffixes longs avant les courts,
    // sinon « Md » serait lu comme « M ».
    views: /\d[\d\s\u00a0\u202f.,]*\s*(?:mrd|md|k|m|b)?\s*(?:de\s+)?(?:vues?|views?|visualizzazioni|aufrufe)/i,
    date: /il y a |\bago\b|hier|aujourd|diffus|streamed|premiere|en direct|\blive\b/i,
    duration: /^\d{1,3}(?::[0-5]\d){1,2}$/,
    // Les cartes compactes ecrivent les vues sans le mot : « 1 M », « 272 k ».
    bareCount: /^\d[\d\s.,]*\s*(?:mrd|md|k|m|b)?$/i,
    multiplier: /^\d+(?:[.,]\d+)?\s*x$/i
  };

  /**
   * « 379 k vues » -> 379000, « 1,2 M de vues » -> 1200000, « 12 345 vues » -> 12345.
   * Gere la virgule decimale francaise comme le point anglais.
   */
  function parseCount(text) {
    const m = String(text).match(/(\d[\d\s\u00a0\u202f.,]*)\s*(mrd|md|k|m|b)?/i);
    if (!m) return '';

    let num = m[1].replace(/[\s\u00a0\u202f]/g, '').replace(/[.,]$/, '');
    if (num.includes(',') && num.includes('.')) {
      num = num.replace(/\./g, '').replace(',', '.');          // 1.234,5
    } else if (/^\d+,\d{1,2}$/.test(num)) {
      num = num.replace(',', '.');                             // 1,2
    } else {
      num = num.replace(/,/g, '');                             // 1,234
    }

    const value = parseFloat(num);
    if (!Number.isFinite(value)) return '';
    const mult = { k: 1e3, m: 1e6, md: 1e9, mrd: 1e9, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
    return Math.round(value * mult);
  }

  /* ------------------------------------------------------------- remise */

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* plus d'activation utilisateur : on tente l'ancienne methode */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  /** Le BOM evite qu'Excel massacre les accents a l'ouverture du fichier. */
  function downloadText(text, filename) {
    try {
      const blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * La copie a TOUJOURS lieu ; le fichier s'ajoute par-dessus si le reglage le
   * demande. Une page web ne peut pas deposer un vrai fichier dans le
   * presse-papiers — seulement du texte : le telechargement est donc le seul
   * moyen d'obtenir un .csv a joindre quelque part.
   *
   * Renvoie { ok, copied, file } pour que le bouton dise ce qui s'est passe.
   */
  async function deliver(text, filename) {
    const copied = await copyText(text);
    const file = current.saveAsFile ? downloadText(text, filename) : false;
    return { ok: copied || file, copied, file };
  }

  /* --------------------------------------------- maintien d'un bouton pose */

  /**
   * Garde un bouton en place dans une page qui se reconstruit sans arret.
   *
   * Deux garde-fous, chacun bouchant le trou de l'autre :
   *
   *  - un throttle a bord de FUITE. La version precedente ignorait toute
   *    mutation survenue dans les 600 ms suivant une verification aboutie. Si
   *    YouTube reconstruisait la rangee d'actions pile dans cette fenetre et que
   *    la page se taisait ensuite, plus aucune verification ne se declenchait :
   *    le bouton restait absent jusqu'a la navigation suivante. On regroupe donc
   *    les mutations sans jamais perdre la derniere.
   *
   *  - une relance espacee tant que le bouton est attendu mais absent, pour ne
   *    dependre d'aucune mutation future : la rangee peut arriver dans une page
   *    devenue silencieuse.
   */
  function keepMounted({ id, wanted, place, refresh }) {
    let timer = null;
    let essais = 0;
    let enAttente = false;
    let dernier = 0;

    const vivant = () => {
      const el = document.getElementById(id);
      return el && el.isConnected ? el : null;
    };

    function planifie(delai = 200) {
      clearTimeout(timer);
      timer = setTimeout(tick, delai);
    }

    function tick() {
      const el = vivant();

      if (!wanted()) { if (el) el.remove(); essais = 0; return; }
      if (el) { if (refresh) refresh(el); essais = 0; return; }

      try { place(); } catch { /* la rangee n'est pas encore prete */ }

      if (vivant()) { essais = 0; return; }
      if (essais < 40) {
        essais++;
        planifie(Math.min(2000, 150 + essais * 100));
      }
    }

    function relance(delai) { essais = 0; planifie(delai); }

    window.addEventListener('yt-navigate-finish', () => relance(400));
    window.addEventListener('yt-page-data-updated', () => relance(400));
    settings.onChange(() => relance(0));

    new MutationObserver(() => {
      if (enAttente) return;
      enAttente = true;
      setTimeout(() => {
        enAttente = false;
        dernier = Date.now();
        tick();
      }, Math.max(0, 400 - (Date.now() - dernier)));
    }).observe(document.documentElement, { childList: true, subtree: true });

    // On attend les reglages : sans ca, un bouton desactive apparaitrait une
    // fraction de seconde avant d'etre retire.
    settings.ready.then(() => relance(600));
  }

  /** Morceau de nom de fichier sur : sans accents, sans espaces, borne. */
  function slug(value, fallback) {
    const out = String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      .slice(0, 48);
    return out || fallback;
  }

  function stamp() {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  }

  window.__yttools = { settings, deliver, copyText, downloadText, keepMounted, RE, parseCount, slug, stamp };
})();
