'use strict';

/**
 * YouTube Tools — copie de la transcription YouTube au format CSV.
 *
 * Un petit bouton « texte » est ajoute a cote du bouton J'aime. Au clic :
 *  1. on ouvre le panneau de transcription comme le ferait un humain
 *     (deplier la description -> « Afficher la transcription ») ;
 *  2. on lit les segments (timecode + texte) ;
 *  3. on remet la page dans l'etat ou on l'a trouvee ;
 *  4. on copie le tout en CSV dans le presse-papiers.
 *
 * La lecture ne s'appuie sur aucun nom de classe : on repere les noeuds dont le
 * texte *est* un timecode, puis on remonte jusqu'a la ligne qui les contient.
 * Ca survit aux renommages de YouTube et fonctionne meme si une autre extension
 * a redecore le panneau.
 *
 * Tout est lu dans le DOM. L'extension n'emet AUCUNE requete vers YouTube : un
 * repli qui interrogeait /youtubei/v1/get_transcript a ete retire pour ne pas
 * ressembler a du trafic automatise.
 */

(() => {
  if (window.__yttoolsTranscriptLoaded) return;
  window.__yttoolsTranscriptLoaded = true;

  const BTN_ID = 'yttools-transcript-btn';

  // Fourni par common.js, charge avant ce script dans le manifest. Sans lui rien
  // ne peut fonctionner : mieux vaut renoncer franchement qu'a moitie.
  const TV = window.__yttools;
  if (!TV) { console.warn('[YouTube Tools] common.js absent'); return; }
  const MARK = 'data-yttools-ts';
  const TS_RE = /^\d{1,3}(?::[0-5]\d){1,2}$/;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeout = 6000, step = 100) {
    const end = Date.now() + timeout;
    for (;;) {
      let v = null;
      try { v = fn(); } catch { /* DOM en cours de rendu */ }
      if (v) return v;
      if (Date.now() > end) return null;
      await sleep(step);
    }
  }

  /* -------------------------------------------------------------- timecodes */

  function parseTs(text) {
    const parts = String(text).trim().split(':');
    if (parts.length < 2 || parts.length > 3) return null;
    let total = 0;
    for (const p of parts) {
      const n = Number(p);
      if (!Number.isFinite(n)) return null;
      total = total * 60 + Math.abs(n);
    }
    return total;
  }

  function fmt(sec, withHours) {
    const s = Math.max(0, Math.round(sec));
    const p2 = (n) => String(n).padStart(2, '0');
    return withHours
      ? Math.floor(s / 3600) + ':' + p2(Math.floor((s % 3600) / 60)) + ':' + p2(s % 60)
      : Math.floor(s / 60) + ':' + p2(s % 60);
  }

  /**
   * La fin d'un segment est le debut du suivant. Pour le dernier, on reprend
   * l'ecart avec le precedent (borne a 30 s) : une moyenne globale se ferait
   * fausser par le moindre grand trou dans la transcription.
   */
  function closeEnds(rows) {
    for (let i = 0; i < rows.length - 1; i++) {
      if (rows[i].end === null) rows[i].end = rows[i + 1].start;
    }
    const last = rows[rows.length - 1];
    if (last && last.end === null) {
      const gap = rows.length > 1 ? last.start - rows[rows.length - 2].start : 4;
      last.end = last.start + Math.min(30, Math.max(1, Math.round(gap)));
    }
    return rows;
  }

  /* ------------------------------------------------- lecture generique du DOM */

  /** Les noeuds feuilles dont le texte complet est un timecode. */
  function timestampLeaves(root) {
    const found = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let el = walker.nextNode(); el; el = walker.nextNode()) {
      if (el.children.length) continue;
      const t = el.textContent.trim();
      if (t.length >= 4 && t.length <= 9 && TS_RE.test(t)) found.push(el);
    }
    return found;
  }

  /**
   * Depuis un timecode, remonte jusqu'au plus grand ancetre qui ne contient pas
   * d'autre timecode : c'est la ligne du segment.
   */
  function rowOf(stamp, root) {
    let node = stamp;
    for (let i = 0; i < 8; i++) {
      const parent = node.parentElement;
      if (!parent || parent === root) break;
      if (parent.querySelectorAll('[' + MARK + ']').length > 1) break;
      node = parent;
    }
    return node;
  }

  /**
   * « 1 minute et 2 secondes » -> 62. Renvoie null si le texte ne ressemble pas
   * a une duree parlee.
   */
  function spokenSeconds(text) {
    const unites = [
      [/(\d+)\s*(?:h\b|heures?|hours?|hrs?\b|std\b)/i, 3600],
      [/(\d+)\s*(?:min(?:ute)?s?\b)/i, 60],
      [/(\d+)\s*(?:s\b|sec(?:onde|ond)?e?s?\b|sek\b)/i, 1]
    ];
    let total = 0;
    let trouve = 0;
    for (const [re, mult] of unites) {
      const m = text.match(re);
      if (m) { total += Number(m[1]) * mult; trouve++; }
    }
    return trouve ? total : null;
  }

  /**
   * Le texte d'une ligne de transcription.
   *
   * A cote du timecode visible, YouTube place sa version parlee pour les
   * lecteurs d'ecran (« 1 minute et 2 secondes »). Prendre le textContent de la
   * ligne collait ce libelle au sous-titre : « 1 minute et 2 secondesEvery job
   * is still random ». On assemble donc les feuilles une a une, en ecartant le
   * timecode et toute feuille dont la duree parlee vaut exactement le debut du
   * segment — un sous-titre qui commencerait par « 3 minutes plus tard » reste
   * ainsi intact.
   */
  function rowText(node, stamp, start) {
    const morceaux = [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
    for (let el = walker.nextNode(); el; el = walker.nextNode()) {
      if (el.children.length) continue;
      if (el === stamp) continue;
      const t = clean(el.textContent);
      if (!t) continue;
      if (spokenSeconds(t) === start) continue;       // le timecode, en toutes lettres
      morceaux.push(t);
    }

    if (morceaux.length) return clean(morceaux.join(' '));

    // Structure plate, sans feuille exploitable : on retire le timecode du tout.
    const label = stamp.textContent;
    let texte = node.textContent;
    const at = texte.indexOf(label);
    if (at >= 0) texte = texte.slice(0, at) + texte.slice(at + label.length);
    return clean(texte);
  }

  function readSegments(root) {
    const stamps = timestampLeaves(root);
    if (stamps.length < 2) return [];
    stamps.forEach((s) => s.setAttribute(MARK, ''));

    const rows = [];
    try {
      for (const stamp of stamps) {
        const start = parseTs(stamp.textContent);
        if (start === null) continue;

        const node = rowOf(stamp, root);
        if (node === stamp) continue;             // timecode isole, sans texte

        const text = rowText(node, stamp, start);
        if (text) rows.push({ start, end: null, text });
      }
    } finally {
      stamps.forEach((s) => s.removeAttribute(MARK));
    }

    rows.sort((a, b) => a.start - b.start);

    closeEnds(rows);
    return rows;
  }

  /* ---------------------------------------------------- reperage du panneau */

  const PANEL_SELECTORS = [
    'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]',
    '[target-id*="transcript" i]',
    'ytd-transcript-renderer',
    'ytd-transcript-search-panel-renderer',
    // Dernier recours, si YouTube renommait le target-id : n'importe quel
    // panneau ouvert et suffisamment fourni (voir le garde-fou ci-dessous).
    'ytd-engagement-panel-section-list-renderer'
  ];

  // Ces panneaux contiennent eux aussi des timecodes : jamais les confondre
  // avec la transcription.
  const NOT_TRANSCRIPT = /chapter|macro-markers|clip|comment|description/i;

  /** Le panneau visible qui contient effectivement des timecodes. */
  function findPanel() {
    for (let i = 0; i < PANEL_SELECTORS.length; i++) {
      const loose = i === PANEL_SELECTORS.length - 1;
      for (const node of document.querySelectorAll(PANEL_SELECTORS[i])) {
        if (!node.isConnected) continue;
        if (node.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN') continue;
        const target = node.getAttribute('target-id') || '';
        if (NOT_TRANSCRIPT.test(target)) continue;
        // Sur le selecteur fourre-tout on exige un vrai volume de timecodes,
        // pour ne pas ramasser une liste de chapitres non identifiee.
        if (timestampLeaves(node).length >= (loose ? 8 : 2)) return node;
      }
    }
    return null;
  }

  function panelShell() {
    return document.querySelector(PANEL_SELECTORS[0]) || document.querySelector(PANEL_SELECTORS[1]);
  }

  /** Le bouton « Afficher la transcription », quelle que soit la langue. */
  function findTrigger() {
    const section = document.querySelector('ytd-video-description-transcript-section-renderer');
    if (section) {
      const buttons = [...section.querySelectorAll('button, a[role="button"]')];
      if (buttons.length) return buttons[buttons.length - 1];
    }
    const scope = document.querySelectorAll(
      '#structured-description button, #description button, ytd-watch-metadata button'
    );
    for (const b of scope) {
      // Notre propre bouton vit dans ytd-watch-metadata et son libelle contient
      // « transcription » : sans ce garde-fou, il se cliquerait lui-meme.
      if (b.id === BTN_ID || b.closest('#' + BTN_ID)) continue;
      const label = b.getAttribute('aria-label') || b.textContent || '';
      if (/transcri/i.test(label)) return b;
    }
    return null;
  }

  function descExpander(which) {
    return document.querySelector(
      'ytd-text-inline-expander #' + which + ', #description-inline-expander #' + which
    );
  }

  async function fromPanel() {
    // Deja ouvert et rempli (par nous, par l'utilisateur ou par une autre
    // extension) : on lit sans rien toucher a la page.
    const open = findPanel();
    if (open) {
      const rows = readSegments(open);
      if (rows.length) return rows;
    }

    let expandedDesc = false;
    let trigger = findTrigger();
    if (!trigger) {
      const expand = descExpander('expand');
      if (expand) {
        expand.click();
        expandedDesc = true;
        trigger = await waitFor(findTrigger, 3000);
      }
    }
    if (!trigger) {
      if (expandedDesc) descExpander('collapse')?.click();
      return null;
    }

    trigger.click();

    const restore = () => {
      panelShell()?.querySelector('#visibility-button button')?.click();
      if (expandedDesc) descExpander('collapse')?.click();
    };

    const panel = await waitFor(findPanel, 9000, 150);
    if (!panel) { restore(); return null; }

    // Le panneau se remplit progressivement : on attend que le compte se fige.
    const count = () => timestampLeaves(panel).length;
    let previous = -1;
    let current = count();
    for (let i = 0; i < 30 && current !== previous; i++) {
      previous = current;
      await sleep(180);
      current = count();
    }

    const rows = readSegments(panel);
    restore();
    return rows.length ? rows : null;
  }

  /* -------------------------------------------------------------------- CSV */

  const cell = (v) => '"' + String(v === undefined || v === null ? '' : v).replace(/"/g, '""') + '"';

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  /** Le premier selecteur qui donne du texte. */
  function pickText(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const v = clean(el.getAttribute('title') || el.textContent);
      if (v) return v;
    }
    return '';
  }

  /**
   * Metadonnees de la video, lues une seule fois puis repetees sur chaque ligne
   * — c'est ce qui permet de concatener plusieurs transcriptions dans un meme
   * fichier sans perdre de quelle video vient chaque ligne.
   */
  /** Les textes de feuilles d'un conteneur, dans l'ordre d'affichage. */
  function leafTexts(root) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let el = walker.nextNode(); el; el = walker.nextNode()) {
      if (el.children.length) continue;
      const t = clean(el.textContent);
      if (t) out.push(t);
    }
    return out;
  }

  // « 17 aout 2026 », « Aug 17, 2026 », « 2026-08-17 » : une page de lecture
  // affiche parfois une date ABSOLUE, que RE.date (concu pour le « il y a » des
  // cartes) ne reconnait pas.
  const ANNEE_RE = /\b(19|20)\d{2}\b/;

  const sansAccents = (t) =>
    String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  const MOIS = {
    jan: 1, feb: 2, fev: 2, mar: 3, apr: 4, avr: 4, may: 5, mai: 5, jun: 6, jui: 6,
    jul: 7, aug: 8, aou: 8, sep: 9, oct: 10, nov: 11, dec: 12
  };

  const isoDe = (d) =>
    d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');

  /** « 17 aout 2026 », « Aug 17, 2026 », « 2026-08-17 » -> « 2026-08-17 ». */
  function absolueEnIso(texte) {
    const t = sansAccents(texte);

    const iso = t.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return iso[0];

    const jma = t.match(/(\d{1,2})\s+([a-z]{3,})\.?\s+(\d{4})/);       // 17 aout 2026
    if (jma && MOIS[jma[2].slice(0, 3)]) {
      return jma[3] + '-' + String(MOIS[jma[2].slice(0, 3)]).padStart(2, '0') +
             '-' + String(jma[1]).padStart(2, '0');
    }

    const mja = t.match(/([a-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/);     // Aug 17, 2026
    if (mja && MOIS[mja[1].slice(0, 3)]) {
      return mja[3] + '-' + String(MOIS[mja[1].slice(0, 3)]).padStart(2, '0') +
             '-' + String(mja[2]).padStart(2, '0');
    }
    return '';
  }

  // « sem » avant « sec », et « min » avant « m » (mois) : sinon « semaine »
  // serait lu comme des secondes et « mois » comme des minutes.
  const UNITES = [
    [/^sem|^week/, (d, n) => d.setDate(d.getDate() - n * 7)],
    [/^min/, (d, n) => d.setMinutes(d.getMinutes() - n)],
    [/^sec|^s$/, (d, n) => d.setSeconds(d.getSeconds() - n)],
    [/^h$|^heure|^hour|^hr/, (d, n) => d.setHours(d.getHours() - n)],
    [/^j$|^jour|^day/, (d, n) => d.setDate(d.getDate() - n)],
    [/^m$|^mois|^month/, (d, n) => d.setMonth(d.getMonth() - n)],
    [/^an|^a$|^year|^yr/, (d, n) => d.setFullYear(d.getFullYear() - n)]
  ];

  /**
   * « il y a 9 mois » -> date d'aujourd'hui moins 9 mois.
   *
   * Approximatif par nature, mais une date relative pourrit : « il y a 9 mois »
   * designera autre chose dans trois mois. Mieux vaut une date figee, meme
   * approchee, dans un fichier destine a etre conserve.
   */
  function relativeEnIso(texte) {
    const t = sansAccents(texte);
    const m = t.match(/(\d+)\s*([a-z]+)/);
    if (!m) return '';
    const n = Number(m[1]);
    const d = new Date();
    for (const [re, applique] of UNITES) {
      if (re.test(m[2])) { applique(d, n); return isoDe(d); }
    }
    return '';
  }

  /**
   * La date exacte est dans les microdonnees schema.org de la page — donc dans
   * le HTML, sans aucune requete. Apres une navigation interne ce bloc peut
   * rester celui de la video precedente : on ne s'en sert que si une de ses URL
   * porte bien l'identifiant courant.
   */
  function dateMicrodonnees(id) {
    const meta = document.querySelector(
      'meta[itemprop="datePublished"], meta[itemprop="uploadDate"]'
    );
    const contenu = meta ? meta.getAttribute('content') || '' : '';
    if (!/^\d{4}-\d{2}-\d{2}/.test(contenu)) return '';

    if (!id) return '';
    const ref = document.querySelector('link[itemprop="thumbnailUrl"], link[itemprop="embedUrl"]');
    const href = ref ? ref.getAttribute('href') || '' : '';
    if (!href || !href.includes(id)) return '';      // rien pour verifier : on s'abstient

    return contenu.slice(0, 10);
  }

  function videoMeta() {
    const id = new URLSearchParams(location.search).get('v') || '';

    // Vues et date partagent le meme conteneur, sans etiquette : on les
    // distingue par ce qu'elles disent.
    //
    // Attention : querySelector('a, b, c') rend le premier element dans l'ordre
    // du DOCUMENT, pas dans l'ordre des selecteurs. Lister plusieurs identifiants
    // d'un coup faisait tomber sur un autre « #info » de la page, d'ou des
    // colonnes vues et date vides. On essaie donc les conteneurs un par un.
    let frags = [];
    for (const sel of ['ytd-watch-info-text #info', 'ytd-watch-info-text', '#info-container']) {
      const zone = document.querySelector(sel);
      if (!zone) continue;
      frags = leafTexts(zone);
      if (frags.length) break;
    }

    let vues = frags.find((t) => TV.RE.views.test(t)) || '';
    let date = frags.find((t) =>
      !TV.RE.views.test(t) && (TV.RE.date.test(t) || ANNEE_RE.test(t))) || '';

    // Replis : l'ancien renderer, puis un balayage du bloc de metadonnees.
    if (!vues) {
      vues = pickText([
        'ytd-video-view-count-renderer .view-count',
        'ytd-video-view-count-renderer .short-view-count',
        '.view-count',
        '.short-view-count'
      ]);
    }
    const bloc = document.querySelector('ytd-watch-metadata');
    if ((!vues || !date) && bloc) {
      const tout = leafTexts(bloc);
      if (!vues) vues = tout.find((t) => TV.RE.views.test(t)) || '';
      if (!date) {
        date = tout.find((t) =>
          !TV.RE.views.test(t) && t.length <= 40 &&
          (TV.RE.date.test(t) || ANNEE_RE.test(t))) || '';
      }
    }

    return {
      titre: pickText(['ytd-watch-metadata h1 yt-formatted-string', 'ytd-watch-metadata h1', '#title h1']),
      chaine: pickText([
        '#owner ytd-channel-name #text a',
        '#owner ytd-channel-name #text',
        'ytd-video-owner-renderer ytd-channel-name #text',
        '#owner a[href^="/@"]'
      ]),
      vues,
      vues_num: vues ? TV.parseCount(vues) : '',
      date,
      date_iso: dateMicrodonnees(id) || absolueEnIso(date) || relativeEnIso(date),
      duree: pickText(['.ytp-time-duration']),
      url: id ? 'https://www.youtube.com/watch?v=' + id : location.href,
      id
    };
  }

  const COLUMNS = ['titre', 'chaine', 'debut', 'fin', 'debut_s', 'texte',
                   'date', 'date_iso', 'vues', 'vues_num', 'duree', 'url', 'id'];

  function toCsv(rows) {
    const meta = videoMeta();
    const withHours = rows[rows.length - 1].start >= 3600;
    const lines = [COLUMNS.join(',')];

    for (const r of rows) {
      const ligne = {
        ...meta,
        debut: fmt(r.start, withHours),
        fin: fmt(r.end, withHours),
        debut_s: Math.round(r.start * 100) / 100,
        texte: r.text
      };
      lines.push(COLUMNS.map((c) => cell(ligne[c])).join(','));
    }
    return lines.join('\r\n');
  }

  /** Un nom de fichier qui rappelle de quelle video vient la transcription. */
  function fileName() {
    const id = new URLSearchParams(location.search).get('v') || '';
    const titre = document.querySelector('#title h1, h1.ytd-watch-metadata');
    const base = TV.slug(titre ? titre.textContent : '', '') || TV.slug(id, 'video');
    return 'transcription-' + base + '-' + TV.stamp() + '.csv';
  }

  /* ----------------------------------------------------------------- bouton */

  const ICON_TEXT =
    '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">' +
    '<path d="M4 5h16v2H4zM4 10h16v2H4zM4 15h11v2H4z"/></svg>';
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
    btn.disabled = state === 'loading';
    btn.querySelector('.yttools-tr-icon').innerHTML =
      state === 'ok' ? ICON_OK : state === 'ko' ? ICON_KO : ICON_TEXT;
    btn.querySelector('.yttools-tr-label').textContent = label || '';
    if (state === 'ok' || state === 'ko') {
      resetTimer = setTimeout(() => setState(btn, 'idle', ''), 2400);
    }
  }

  /** Ce qu'il faut me montrer si ca ne marche pas : un seul console.warn. */
  function diagnose() {
    const shell = panelShell();
    return {
      url: location.href,
      panneauTrouve: !!findPanel(),
      panneauPresent: shell ? shell.tagName.toLowerCase() : null,
      visibilite: shell ? shell.getAttribute('visibility') : null,
      timecodesDansLePanneau: shell ? timestampLeaves(shell).length : 0,
      timecodesDansLaPage: timestampLeaves(document.body).length,
      boutonTranscription: !!findTrigger()
    };
  }

  async function onClick(btn) {
    if (btn.dataset.state === 'loading') return;
    setState(btn, 'loading', '');

    let rows = null;
    try { rows = await fromPanel(); } catch (e) { console.warn('[YouTube Tools] panneau', e); }

    if (!rows || !rows.length) {
      console.warn('[YouTube Tools] transcription introuvable', diagnose());
      setState(btn, 'ko', 'Introuvable');
      return;
    }

    const { ok, file } = await TV.deliver(toCsv(rows), fileName());
    if (!ok) { setState(btn, 'ko', 'Copie refusée'); return; }
    setState(btn, 'ok', rows.length + (file ? ' lignes ⤓' : ' lignes'));
  }

  /** Le libelle dit ce que le clic va reellement faire. */
  function hint() {
    return TV.settings.get().saveAsFile
      ? 'Copier la transcription en CSV et enregistrer le fichier'
      : 'Copier la transcription au format CSV';
  }

  function build() {
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.className = 'yttools-tr-btn';
    btn.type = 'button';
    btn.dataset.state = 'idle';
    btn.title = hint();
    btn.setAttribute('aria-label', hint());
    btn.innerHTML =
      '<span class="yttools-tr-icon">' + ICON_TEXT + '</span>' +
      '<span class="yttools-tr-label"></span>';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick(btn);
    });
    return btn;
  }

  /* -------------------------------------------------------------- injection */

  function isWatchPage() {
    return location.pathname === '/watch' && !!new URLSearchParams(location.search).get('v');
  }

  /** Le reglage « enregistrer un fichier » a pu changer depuis l'injection. */
  function refresh(el) {
    const h = hint();
    if (el.title === h) return;
    el.title = h;
    el.setAttribute('aria-label', h);
  }

  function place() {
    const row = document.querySelector(
      'ytd-watch-metadata #top-level-buttons-computed, #actions #top-level-buttons-computed,' +
      '#top-level-buttons-computed, ytd-watch-metadata #actions-inner, ytd-watch-metadata #actions'
    );
    if (!row) return;

    const btn = build();
    const like = row.querySelector(
      'segmented-like-dislike-button-view-model, like-button-view-model, ytd-toggle-button-renderer'
    );

    // Il faut inserer entre deux enfants DIRECTS de la rangee : on remonte donc
    // du bloc J'aime jusqu'a l'enfant direct qui le contient. Exiger que le bloc
    // soit lui-meme enfant direct suffisait avant, mais des que YouTube
    // l'imbrique d'un cran le bouton partait en fin de rangee — hors du cadre du
    // lecteur, donc invisible.
    let ancre = like;
    while (ancre && ancre.parentElement && ancre.parentElement !== row) ancre = ancre.parentElement;

    if (ancre && ancre.parentElement === row) ancre.after(btn);
    else row.insertBefore(btn, row.firstElementChild);   // jamais en fin de rangee
  }

  TV.keepMounted({
    id: BTN_ID,
    wanted: () => isWatchPage() && TV.settings.get().transcriptButton,
    place,
    refresh
  });
})();
