'use strict';

/**
 * Thumbnail View — export CSV des videos chargees sur la page.
 *
 * Un bouton « enregistrer » est ajoute a cote de « A propos de ces resultats »
 * (page de recherche) ou, a defaut, dans la barre du haut. Au clic, il ramasse
 * toutes les cartes video *presentes dans le DOM* et les ecrit en CSV.
 *
 * Il n'y a donc rien a precharger : ce qui est ramasse est exactement ce que la
 * page a deja charge. Trois videos affichees -> trois lignes ; on deroule
 * longuement puis on clique -> tout y est.
 *
 * Les champs sont trouves par ce qu'ils *disent*, pas par leur nom de classe :
 * un fragment « 379 k vues » est reconnu comme des vues, « il y a 1 mois »
 * comme une date, « 1.4x » comme un multiplicateur. Ca traverse les refontes de
 * YouTube et ca marche aussi pour le multiplicateur de vidIQ, dont les classes
 * sont hachees et changent a chaque version.
 */

(() => {
  if (window.__thumbviewVideosLoaded) return;
  window.__thumbviewVideosLoaded = true;

  const BTN_ID = 'thumbview-videos-btn';

  /* ------------------------------------------------------ reperage des cartes */

  const CARD_TAGS = [
    'ytd-video-renderer',
    'ytd-rich-item-renderer',
    'ytd-grid-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-playlist-video-renderer',
    'yt-lockup-view-model',
    'ytm-shorts-lockup-view-model',
    'ytd-reel-item-renderer'
  ].join(',');

  /**
   * Les cartes s'emboitent (ytd-rich-item-renderer contient un
   * yt-lockup-view-model) : sans ce filtre, chaque video compterait double. On
   * ne garde que les cartes qui n'ont pas de carte parente.
   */
  function findCards() {
    const all = [...document.querySelectorAll(CARD_TAGS)].filter((n) => {
      // Jamais la fausse carte posee par l'apercu de miniature.
      if (n.hasAttribute('data-thumbview') || n.closest('[data-thumbview]')) return false;
      return !!n.querySelector('a[href]');
    });
    const set = new Set(all);
    return all.filter((n) => {
      for (let p = n.parentElement; p; p = p.parentElement) if (set.has(p)) return false;
      return true;
    });
  }

  /* ----------------------------------------------------------------- lecture */

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const textOf = (el) => (el ? clean(el.textContent) : '');

  const DURATION_RE = /^\d{1,3}(?::[0-5]\d){1,2}$/;
  const MULTIPLIER_RE = /^\d+(?:[.,]\d+)?\s*x$/i;
  // \u00ab 379 k vues \u00bb, \u00ab 124 vues \u00bb, mais aussi \u00ab 1,2 M de vues \u00bb : au-dela du
  // million, le francais intercale un \u00ab de \u00bb. Les suffixes longs passent avant
  // les courts, sinon \u00ab Md \u00bb serait lu comme \u00ab M \u00bb.
  const VIEWS_RE =
    /\d[\d\s\u00a0\u202f.,]*\s*(?:mrd|md|k|m|b)?\s*(?:de\s+)?(?:vues?|views?|visualizzazioni|aufrufe)/i;
  const DATE_RE = /il y a |\bago\b|hier|aujourd|diffus|streamed|premiere|en direct|\blive\b/i;
  // Les cartes compactes ecrivent les vues sans le mot : « 1 M », « 272 k ».
  const BARE_COUNT_RE = /^\d[\d\s  .,]*\s*(?:mrd|md|k|m|b)?$/i;

  /**
   * YouTube agrege parfois plusieurs informations dans un seul fragment
   * (« 11 k vues · 6 hours ago »). On les separe avant de les classer, sinon la
   * date recupere aussi les vues.
   */
  function expand(list) {
    const out = [];
    for (const t of list) {
      // Les morceaux *remplacent* le composite : le garder en tete ferait
      // matcher « 11 k vues · 6 hours ago » comme date entiere.
      // Uniquement les puces : « | » decouperait des titres et des noms de
      // chaine qui en contiennent legitimement.
      const bits = t.split(/[··•]/).map(clean).filter(Boolean);
      if (bits.length > 1) out.push(...bits);
      else out.push(t);
    }
    return out;
  }

  /** Tous les textes de feuilles courtes de la carte, hors titre. */
  function leafTexts(card, skip) {
    const out = [];
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_ELEMENT);
    for (let el = walker.nextNode(); el; el = walker.nextNode()) {
      if (el.children.length) continue;
      if (skip && (el === skip || skip.contains(el))) continue;
      const t = clean(el.textContent);
      if (t && t.length <= 60) out.push(t);
    }
    return out;
  }

  function firstMatch(list, re) {
    for (const t of list) if (re.test(t)) return t;
    return '';
  }

  function pick(card, selectors) {
    for (const sel of selectors) {
      const el = card.querySelector(sel);
      if (el) {
        const value = clean(el.getAttribute('title') || el.textContent);
        if (value) return value;
      }
    }
    return '';
  }

  // Sur une carte Short, le titre porte sur le <a> a l'interieur du <h3>, pas
  // sur le <h3> : sans « h3 a[title] », les Shorts ressortaient sans titre.
  const TITLE_SEL = [
    'a#video-title',
    '#video-title',
    '.ytLockupMetadataViewModelTitle',
    '.shortsLockupViewModelHostMetadataTitle a',
    'h3 a[title]',
    'h3[title]'
  ].join(',');

  function titleOf(card) {
    for (const sel of TITLE_SEL.split(',')) {
      const el = card.querySelector(sel);
      if (!el) continue;
      const text = clean(el.getAttribute('title') || el.textContent);
      if (text) return { text, node: el };
    }
    return { text: '', node: null };
  }

  function linkOf(card) {
    const a = card.querySelector('a[href*="/watch?v="], a[href^="/shorts/"], a[href*="/shorts/"]');
    if (!a) return { url: '', id: '', type: 'video' };
    let url;
    try { url = new URL(a.getAttribute('href'), location.origin); } catch { return { url: '', id: '', type: 'video' }; }

    const shorts = url.pathname.match(/^\/shorts\/([^/?#]+)/);
    if (shorts) return { url: 'https://www.youtube.com/shorts/' + shorts[1], id: shorts[1], type: 'short' };

    const id = url.searchParams.get('v') || '';

    // Une pile de miniatures = une playlist. Sans ca elle ressortirait comme une
    // video sans vues ni duree, ce qui fausserait toute lecture du fichier.
    const playlist = !!card.querySelector('yt-collection-thumbnail-view-model, yt-collections-stack');
    return {
      url: id ? 'https://www.youtube.com/watch?v=' + id : '',
      id,
      type: playlist ? 'playlist' : 'video'
    };
  }

  /**
   * « 379 k vues » -> 379000, « 1,2 M vues » -> 1200000, « 12 345 vues » -> 12345.
   * Gere la virgule decimale francaise comme le point anglais.
   */
  function parseCount(text) {
    // Suffixes longs d'abord : sinon \u00ab Md \u00bb serait lu comme \u00ab M \u00bb (facteur 1000).
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

  function readCard(card) {
    const { text: titre, node: titleNode } = titleOf(card);
    const { url, id, type } = linkOf(card);
    if (!titre && !url) return null;

    // Emplacements ou YouTube range ses metadonnees, tous formats de carte
    // confondus. Le sous-titre des Shorts en fait partie.
    const explicit = [...card.querySelectorAll(
      '.inline-metadata-item, .ytContentMetadataViewModelMetadataText, #metadata-line span,' +
      '.shortsLockupViewModelHostMetadataSubhead'
    )].map(textOf).filter(Boolean);
    const parts = expand(explicit);
    const leaves = expand(leafTexts(card, titleNode));

    // « 379 k vues » d'abord ; a defaut, le compte nu des cartes compactes, mais
    // seulement parmi les metadonnees identifiees — dans le balayage generique,
    // « 573 k » serait le nombre d'abonnes, pas les vues.
    const vues =
      firstMatch(parts, VIEWS_RE) ||
      firstMatch(leaves, VIEWS_RE) ||
      firstMatch(parts, BARE_COUNT_RE);
    const date = firstMatch(parts, DATE_RE) || firstMatch(leaves, DATE_RE);

    // Le multiplicateur vient de vidIQ, hors des classes YouTube : toujours le
    // chercher dans toutes les feuilles.
    const multiplicateur = firstMatch(leaves, MULTIPLIER_RE);

    // Le premier badge d'un Short est « Nouveau » : on parcourt tous les badges
    // et on garde celui qui ressemble a une duree, pas seulement le premier.
    const badges = [...card.querySelectorAll(
      '.ytBadgeShapeText, ytd-thumbnail-overlay-time-status-renderer #text, .badge-shape-wiz__text'
    )].map(textOf);
    const duree = firstMatch(badges, DURATION_RE) || firstMatch(leaves, DURATION_RE);

    const chaine =
      pick(card, [
        'ytd-channel-name #text',
        '#channel-name #text',
        '#attributed-channel-name',
        'a[href^="/@"]',
        'a[href^="/channel/"]',
        'a[href^="/c/"]'
      ]) ||
      // Sur les nouvelles cartes, la chaine est la premiere ligne de
      // metadonnees qui ne parle ni de vues ni de date. Uniquement parmi les
      // emplacements connus : sur le balayage generique, on ramasserait le
      // titre ou un badge « Nouveau » a la place du nom de chaine.
      (parts.find((t) =>
        !VIEWS_RE.test(t) && !DATE_RE.test(t) &&
        !DURATION_RE.test(t) && !MULTIPLIER_RE.test(t) && !BARE_COUNT_RE.test(t)) || '');

    return {
      titre,
      chaine,
      vues,
      vues_num: vues ? parseCount(vues) : '',
      date,
      duree: DURATION_RE.test(duree) ? duree : '',
      multiplicateur: multiplicateur.replace(/\s+/g, ''),
      type,
      id,
      url
    };
  }

  function collect() {
    const rows = [];
    const seen = new Set();
    for (const card of findCards()) {
      let row = null;
      try { row = readCard(card); } catch { /* carte illisible, on passe */ }
      if (!row) continue;
      const key = row.id || row.url || row.titre;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      row.position = rows.length + 1;
      rows.push(row);
    }
    return rows;
  }

  /* --------------------------------------------------------------------- CSV */

  const COLUMNS = ['position', 'titre', 'chaine', 'vues', 'vues_num', 'date', 'duree', 'multiplicateur', 'type', 'url'];
  const cell = (v) => '"' + String(v === undefined || v === null ? '' : v).replace(/"/g, '""') + '"';

  function toCsv(rows) {
    const lines = [COLUMNS.join(',')];
    for (const r of rows) lines.push(COLUMNS.map((c) => cell(r[c])).join(','));
    return lines.join('\r\n');
  }

  /** Un nom de fichier qui rappelle d'ou vient l'export. */
  function fileName() {
    const params = new URLSearchParams(location.search);
    let context = params.get('search_query') || '';
    if (!context) {
      const path = location.pathname.replace(/^\/+|\/+$/g, '');
      context = path || 'accueil';
    }
    context = context
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      .slice(0, 48) || 'page';

    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
    return 'youtube-' + context + '-' + stamp + '.csv';
  }

  /** Le BOM evite qu'Excel massacre les accents a l'ouverture. */
  function download(csv, name) {
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  /* ------------------------------------------------------------------ bouton */

  // Fleche vers le bas posee sur une barre : le pictogramme « enregistrer ».
  const ICON_SAVE =
    '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">' +
    '<path d="M11 3h2v9.2l3.6-3.6L18 10l-6 6-6-6 1.4-1.4L11 12.2V3z"/><path d="M4 18h16v2H4z"/></svg>';
  const ICON_OK =
    '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">' +
    '<path d="M9.6 16.2 5.4 12 4 13.4l5.6 5.6L20.4 8.2 19 6.8z"/></svg>';
  const ICON_KO =
    '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">' +
    '<path d="M12 2 1 21h22L12 2zm0 4.2L19.5 19h-15L12 6.2zM11 10h2v5h-2zm0 6h2v2h-2z"/></svg>';

  let resetTimer = null;

  function setState(btn, state, label) {
    clearTimeout(resetTimer);
    btn.dataset.state = state;
    btn.querySelector('.thumbview-vd-icon').innerHTML =
      state === 'ok' ? ICON_OK : state === 'ko' ? ICON_KO : ICON_SAVE;
    btn.querySelector('.thumbview-vd-label').textContent = label || '';
    if (state === 'ok' || state === 'ko') {
      resetTimer = setTimeout(() => setState(btn, 'idle', ''), 2600);
    }
  }

  function onClick(btn) {
    let rows = [];
    try {
      rows = collect();
    } catch (e) {
      console.warn('[Thumbnail View] export videos', e);
    }

    if (!rows.length) {
      console.warn('[Thumbnail View] aucune video trouvee', {
        url: location.href,
        cartesDetectees: findCards().length
      });
      setState(btn, 'ko', 'Aucune vidéo');
      return;
    }

    download(toCsv(rows), fileName());
    setState(btn, 'ok', rows.length + ' vidéos');
  }

  function build() {
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.className = 'thumbview-vd-btn';
    btn.type = 'button';
    btn.dataset.state = 'idle';
    btn.title = 'Enregistrer les vidéos chargées de la page en CSV';
    btn.setAttribute('aria-label', 'Enregistrer les vidéos chargées de la page en CSV');
    btn.innerHTML =
      '<span class="thumbview-vd-icon">' + ICON_SAVE + '</span>' +
      '<span class="thumbview-vd-label"></span>';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick(btn);
    });
    return btn;
  }

  /* --------------------------------------------------------------- injection */

  function mount() {
    const existing = document.getElementById(BTN_ID);
    if (existing && existing.isConnected) return;

    // L'emplacement demande : juste a cote de « A propos de ces resultats ».
    const header = document.querySelector('#about-these-results');
    if (header) { header.appendChild(build()); return; }

    // Les autres pages n'ont pas cet en-tete : on se rabat sur la barre du haut.
    const masthead = document.querySelector('ytd-masthead #end, #masthead #end');
    if (masthead) masthead.insertBefore(build(), masthead.firstChild);
  }

  let pending = null;
  function schedule(delay = 250) {
    clearTimeout(pending);
    pending = setTimeout(mount, delay);
  }

  window.addEventListener('yt-navigate-finish', () => schedule(400));
  window.addEventListener('yt-page-data-updated', () => schedule(400));

  let lastCheck = 0;
  new MutationObserver(() => {
    const now = Date.now();
    if (now - lastCheck < 700) return;
    lastCheck = now;
    const btn = document.getElementById(BTN_ID);
    if (!btn || !btn.isConnected) schedule(200);
  }).observe(document.documentElement, { childList: true, subtree: true });

  schedule(600);
})();
