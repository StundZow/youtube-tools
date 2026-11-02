'use strict';

/**
 * Mise a jour depuis GitHub — partage par le service worker, le popup et la
 * page de mise a jour (update.html).
 *
 * Principe repris de Slipers/youtube-ad-tool :
 *  - `version.json`, a la racine du depot, annonce la derniere version et la
 *    liste de ses fichiers. C'est release.js qui l'ecrit a chaque publication ;
 *  - aucune API ne laisse une extension reecrire ses propres fichiers : on passe
 *    par l'API File System Access. L'utilisateur designe UNE fois le dossier de
 *    l'extension, les fois suivantes se font sans rien demander ;
 *  - tout est telecharge AVANT d'ecrire quoi que ce soit, puis l'extension se
 *    recharge (chrome.runtime.reload).
 *
 * Seulement pour une extension chargee « non empaquetee » (mode developpeur) :
 * c'est le seul cas ou le dossier choisi EST le code que Chrome execute.
 *
 * Reseau : uniquement raw.githubusercontent.com, sans cookie. Rien vers YouTube.
 * Aucune permission en plus : ce domaine repond a toutes les origines (CORS *).
 */
(function (global) {
  const OWNER = 'StundZow';
  const REPO = 'youtube-tools';
  const DOSSIER = 'youtube-tools';            // dossier de l'extension dans le depot
  const RAW = `https://raw.githubusercontent.com/${OWNER}/${REPO}`;
  const INFO_URL = `${RAW}/main/version.json`;
  const RELEASES_URL = `https://github.com/${OWNER}/${REPO}/releases/latest`;
  const CLE = 'yttoolsUpdate';

  /** Compare deux versions facon « 3.10.0 ». Renvoie 1 si a > b, -1 si a < b. */
  function comparer(a, b) {
    const g = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const d = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(g.length, d.length); i++) {
      const diff = (g[i] || 0) - (d[i] || 0);
      if (diff) return diff > 0 ? 1 : -1;
    }
    return 0;
  }

  const installee = () => chrome.runtime.getManifest().version;

  /** Chargee depuis un dossier (mode developpeur) ? getSelf() ne demande aucune permission. */
  async function estDossierLocal() {
    try {
      return (await chrome.management.getSelf()).installType === 'development';
    } catch {
      return false;
    }
  }

  /**
   * Interroge GitHub et memorise le resultat.
   * Renvoie { disponible, latest, notes, ref, files } ou null (hors ligne,
   * depot injoignable, installation non concernee).
   */
  async function verifier() {
    if (!(await estDossierLocal())) return null;
    try {
      const r = await fetch(`${INFO_URL}?t=${Date.now()}`, { cache: 'no-store', credentials: 'omit' });
      if (!r.ok) return null;
      const info = await r.json();
      const latest = String(info.version || '').trim();
      if (!latest) return null;
      const res = {
        disponible: comparer(latest, installee()) > 0,
        latest,
        notes: String(info.notes || '').trim(),
        ref: String(info.ref || `v${latest}`),
        files: Array.isArray(info.files) ? info.files.map(String) : []
      };
      await chrome.storage.local.set({ [CLE]: { ...res, checkedAt: Date.now() } });
      return res;
    } catch {
      return null;                              // hors ligne : on ne bloque rien
    }
  }

  /** Dernier resultat connu, sans reseau. Perime si la version installee l'a rattrape. */
  async function dernierConnu() {
    const s = (await chrome.storage.local.get(CLE))[CLE];
    if (!s || !s.latest) return null;
    return { ...s, disponible: comparer(s.latest, installee()) > 0 };
  }

  /* ------------------------------------------------------ dossier de l'extension */

  // Le handle survit a la fermeture de la page : seul IndexedDB sait le garder.
  function base() {
    return new Promise((ok, ko) => {
      const req = indexedDB.open('yttools-update', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('handles');
      req.onsuccess = () => ok(req.result);
      req.onerror = () => ko(req.error);
    });
  }

  async function handleMemorise() {
    try {
      const db = await base();
      return await new Promise((ok) => {
        const req = db.transaction('handles').objectStore('handles').get('dossier');
        req.onsuccess = () => ok(req.result || null);
        req.onerror = () => ok(null);
      });
    } catch {
      return null;
    }
  }

  async function memoriser(handle) {
    try {
      const db = await base();
      db.transaction('handles', 'readwrite').objectStore('handles').put(handle, 'dossier');
    } catch {
      // Sans memorisation, il faudra redesigner le dossier la prochaine fois.
    }
  }

  /** On n'ecrit que dans le dossier de CETTE extension : son manifest.json le dit. */
  async function estLeBonDossier(handle) {
    try {
      const f = await (await handle.getFileHandle('manifest.json')).getFile();
      return /youtube tools/i.test(String(JSON.parse(await f.text()).name || ''));
    } catch {
      return false;
    }
  }

  async function dossier(progres) {
    const garde = await handleMemorise();
    if (garde) {
      const perm = await garde.requestPermission({ mode: 'readwrite' });
      if (perm === 'granted' && (await estLeBonDossier(garde))) return garde;
    }
    progres("Choisis le dossier de l'extension (celui qui contient manifest.json)…");
    const choisi = await global.showDirectoryPicker({ mode: 'readwrite', id: 'yttools' });
    if (!(await estLeBonDossier(choisi))) {
      throw new Error("ce dossier n'est pas celui de YouTube Tools : choisis celui où se trouve manifest.json");
    }
    await memoriser(choisi);
    return choisi;
  }

  /** « icons/icon16.png » -> handle de fichier, en creant les sous-dossiers. */
  async function fichier(racine, chemin) {
    const parts = chemin.split('/').filter(Boolean);
    let d = racine;
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
    return d.getFileHandle(parts[parts.length - 1], { create: true });
  }

  /** Chemin sur et relatif au dossier de l'extension : pas de « .. », pas de chemin absolu. */
  const cheminSur = (c) => /^[\w.-]+(\/[\w.-]+)*$/.test(c) && !c.split('/').includes('..');

  /**
   * Telecharge la version annoncee puis l'ecrit dans le dossier de l'extension.
   * `progres(texte)` recoit l'avancement. Leve une erreur en cas d'echec ;
   * dans ce cas aucun fichier n'a ete modifie si l'echec vient du reseau.
   */
  async function installer(info, progres) {
    if (!global.showDirectoryPicker) throw new Error("ce navigateur ne permet pas d'écrire des fichiers");
    const files = info.files.filter(cheminSur);
    if (!files.length || !files.includes('manifest.json')) throw new Error('liste de fichiers invalide');

    const racine = await dossier(progres);

    const recus = [];
    for (let i = 0; i < files.length; i++) {
      progres(`Téléchargement ${i + 1}/${files.length} — ${files[i]}`);
      const url = `${RAW}/${encodeURIComponent(info.ref)}/${DOSSIER}/${files[i]}`;
      const r = await fetch(url, { cache: 'no-store', credentials: 'omit' });
      if (!r.ok) throw new Error(`${files[i]} introuvable (HTTP ${r.status})`);
      recus.push({ chemin: files[i], data: await r.arrayBuffer() });
    }

    // manifest.json en dernier : tant qu'il n'est pas ecrit, Chrome garde
    // l'ancienne version au prochain rechargement.
    recus.sort((a, b) => (a.chemin === 'manifest.json') - (b.chemin === 'manifest.json'));
    const echecs = [];
    for (let i = 0; i < recus.length; i++) {
      const { chemin, data } = recus[i];
      // Un fichier a ecrire a echoue : on n'annonce pas la nouvelle version.
      if (chemin === 'manifest.json' && echecs.length) break;
      progres(`Installation ${i + 1}/${recus.length} — ${chemin}`);
      try {
        const h = await fichier(racine, chemin);
        if (await identique(h, chemin, data)) continue;
        const w = await h.createWritable();
        await w.write(data);
        await w.close();
      } catch {
        // Un antivirus peut bloquer un fichier au moment de l'ecrire : on note,
        // on continue avec les autres, et on le dit a la fin.
        echecs.push(chemin);
      }
    }
    if (echecs.length) {
      throw new Error(`${echecs.length} fichier(s) n'ont pas pu être écrits (${echecs.join(', ')}). ` +
        "Ton antivirus les a peut-être bloqués. Réessaie, ou télécharge la version à la main.");
    }
  }

  const TEXTE = /\.(js|css|html|json|md|txt)$/i;

  /**
   * Le fichier present a-t-il deja ce contenu ? On n'ecrit alors rien : moins
   * d'ecritures, c'est moins de risques (fichier ouvert, antivirus). Pour du
   * texte, on ignore les fins de ligne : un depot Git sous Windows les met en
   * CRLF, GitHub les sert en LF.
   */
  async function identique(handle, chemin, data) {
    try {
      const actuel = await (await handle.getFile()).arrayBuffer();
      if (TEXTE.test(chemin)) {
        const dec = new TextDecoder();
        const norm = (b) => dec.decode(b).replace(/\r\n/g, '\n');
        return norm(actuel) === norm(data);
      }
      const a = new Uint8Array(actuel);
      const b = new Uint8Array(data);
      return a.length === b.length && a.every((x, i) => x === b[i]);
    } catch {
      return false;                              // illisible ou absent : on ecrit
    }
  }

  global.__yttoolsUpdate = {
    RELEASES_URL, comparer, installee, estDossierLocal, verifier, dernierConnu, installer, cheminSur
  };
})(typeof self !== 'undefined' ? self : globalThis);
