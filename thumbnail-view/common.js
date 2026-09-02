'use strict';

/**
 * Thumbnail View — reglages partages et remise des donnees.
 *
 * Charge avant les autres scripts de contenu, ce module leur expose
 * `window.__thumbview` : les reglages (avec suivi des changements en direct) et
 * une fonction `deliver()` unique.
 *
 * Les deux boutons — transcription et export des videos — passent par cette
 * meme fonction : le reglage « enregistrer un fichier » vaut donc forcement
 * pour les deux, sans risque qu'ils divergent un jour.
 */

(() => {
  if (window.__thumbview) return;

  const KEY = 'thumbviewSettings';
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
    settings.ready = chrome.storage.local.get(KEY)
      .then((stored) => {
        current = { ...DEFAULTS, ...(stored && stored[KEY] ? stored[KEY] : {}) };
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
   * Presse-papiers par defaut, fichier si le reglage le demande.
   * Renvoie { ok, mode } pour que le bouton dise ce qui s'est reellement passe.
   */
  async function deliver(text, filename) {
    if (current.saveAsFile) {
      return { ok: downloadText(text, filename), mode: 'file' };
    }
    return { ok: await copyText(text), mode: 'clipboard' };
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

  window.__thumbview = { settings, deliver, copyText, downloadText, slug, stamp };
})();
