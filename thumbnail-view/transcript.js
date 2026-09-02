'use strict';

/**
 * Thumbnail View — copie de la transcription YouTube au format CSV.
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
 */

(() => {
  if (window.__thumbviewTranscriptLoaded) return;
  window.__thumbviewTranscriptLoaded = true;

  const BTN_ID = 'thumbview-transcript-btn';

  // Fourni par common.js, charge avant ce script. Le repli evite qu'un ordre de
  // chargement inattendu casse la page.
  const TV = window.__thumbview || {
    settings: { get: () => ({ transcriptButton: true, saveAsFile: false }), onChange: () => {}, ready: Promise.resolve() },
    deliver: async () => ({ ok: false, mode: 'clipboard' }),
    slug: (v, f) => f,
    stamp: () => ''
  };
  const MARK = 'data-thumbview-ts';
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

        const label = stamp.textContent;
        let text = node.textContent;
        const at = text.indexOf(label);
        if (at >= 0) text = text.slice(0, at) + text.slice(at + label.length);
        text = text.replace(/\s+/g, ' ').trim();

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

  /* ------------------------------------------------- repli : API InnerTube */

  function pageScripts() {
    let out = '';
    for (const s of document.querySelectorAll('script')) {
      const t = s.textContent;
      if (t) out += t + '\n';
    }
    return out;
  }

  /**
   * Les balises <script> ne sont pas rafraichies lors d'une navigation interne :
   * les parametres peuvent viser une AUTRE video. On verifie donc que l'id de la
   * video courante est bien celui encode dans les parametres, sinon on renonce
   * plutot que de copier la mauvaise transcription.
   */
  function paramsMatchVideo(params, videoId) {
    try {
      const b64 = decodeURIComponent(params).replace(/-/g, '+').replace(/_/g, '/');
      return atob(b64).includes(videoId);
    } catch {
      return false;
    }
  }

  /** Ramasse tout objet ressemblant a un segment, quelle que soit sa profondeur. */
  function harvest(node, out, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 30) return;
    if (Array.isArray(node)) {
      for (const n of node) harvest(n, out, depth + 1);
      return;
    }
    const seg = node.transcriptSegmentRenderer;
    if (seg && seg.snippet) {
      const text = (seg.snippet.runs || [])
        .map((r) => r.text || '')
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      const start = Number(seg.startMs);
      if (text && Number.isFinite(start)) {
        const end = Number(seg.endMs);
        out.push({ start: start / 1000, end: Number.isFinite(end) ? end / 1000 : null, text });
      }
      return;
    }
    for (const k in node) harvest(node[k], out, depth + 1);
  }

  async function fromApi() {
    const videoId = new URLSearchParams(location.search).get('v');
    const src = pageScripts();
    const params = (src.match(/"getTranscriptEndpoint":\s*\{\s*"params":\s*"([^"]+)"/) || [])[1];
    const key = (src.match(/"INNERTUBE_API_KEY":\s*"([^"]+)"/) || [])[1];
    const version = (src.match(/"INNERTUBE_CLIENT_VERSION":\s*"([^"]+)"/) || [])[1];
    if (!params || !key || !version || !videoId) return null;
    if (!paramsMatchVideo(params, videoId)) return null;

    const res = await fetch('/youtubei/v1/get_transcript?key=' + key + '&prettyPrint=false', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: version,
            hl: (src.match(/"HL":\s*"([^"]+)"/) || [])[1] || 'fr',
            gl: (src.match(/"GL":\s*"([^"]+)"/) || [])[1] || 'FR'
          }
        },
        params
      })
    });
    if (!res.ok) return null;

    const rows = [];
    harvest(await res.json(), rows);
    if (!rows.length) return null;

    return closeEnds(rows);
  }

  /* -------------------------------------------------------------------- CSV */

  const cell = (v) => '"' + String(v).replace(/"/g, '""') + '"';

  function toCsv(rows) {
    const withHours = rows[rows.length - 1].start >= 3600;
    const lines = ['start,end,text'];
    for (const r of rows) {
      lines.push([fmt(r.start, withHours), fmt(r.end, withHours), r.text].map(cell).join(','));
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
    btn.querySelector('.thumbview-tr-icon').innerHTML =
      state === 'ok' ? ICON_OK : state === 'ko' ? ICON_KO : ICON_TEXT;
    btn.querySelector('.thumbview-tr-label').textContent = label || '';
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
    try { rows = await fromPanel(); } catch (e) { console.warn('[Thumbnail View] panneau', e); }
    if (!rows) {
      try { rows = await fromApi(); } catch (e) { console.warn('[Thumbnail View] api', e); }
    }

    if (!rows || !rows.length) {
      console.warn('[Thumbnail View] transcription introuvable', diagnose());
      setState(btn, 'ko', 'Introuvable');
      return;
    }

    const { ok, mode } = await TV.deliver(toCsv(rows), fileName());
    if (!ok) { setState(btn, 'ko', mode === 'file' ? 'Échec' : 'Copie refusée'); return; }
    setState(btn, 'ok', rows.length + (mode === 'file' ? ' lignes ⤓' : ' lignes'));
  }

  /** Le libelle dit ce que le clic va reellement faire. */
  function hint() {
    return TV.settings.get().saveAsFile
      ? 'Enregistrer la transcription en CSV'
      : 'Copier la transcription au format CSV';
  }

  function build() {
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.className = 'thumbview-tr-btn';
    btn.type = 'button';
    btn.dataset.state = 'idle';
    btn.title = hint();
    btn.setAttribute('aria-label', hint());
    btn.innerHTML =
      '<span class="thumbview-tr-icon">' + ICON_TEXT + '</span>' +
      '<span class="thumbview-tr-label"></span>';
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

  function mount() {
    const existing = document.getElementById(BTN_ID);
    if (!isWatchPage() || !TV.settings.get().transcriptButton) {
      existing?.remove();
      return;
    }
    if (existing && existing.isConnected) {
      // Le reglage « enregistrer un fichier » a pu changer depuis l'injection.
      existing.title = hint();
      existing.setAttribute('aria-label', hint());
      return;
    }

    const row = document.querySelector(
      'ytd-watch-metadata #top-level-buttons-computed, #actions #top-level-buttons-computed, #top-level-buttons-computed'
    );
    if (!row) return;

    const btn = build();
    // Juste apres le bloc J'aime / Je n'aime pas, sinon en fin de rangee.
    const like = row.querySelector(
      'segmented-like-dislike-button-view-model, like-button-view-model, ytd-toggle-button-renderer'
    );
    if (like && like.parentElement === row) like.after(btn);
    else row.appendChild(btn);
  }

  let pending = null;
  function schedule(delay = 250) {
    clearTimeout(pending);
    pending = setTimeout(mount, delay);
  }

  // YouTube reconstruit la rangee d'actions a chaque navigation interne.
  window.addEventListener('yt-navigate-finish', () => schedule(400));
  window.addEventListener('yt-page-data-updated', () => schedule(400));

  // Activation, desactivation ou changement de mode : effet immediat, sans
  // avoir a recharger l'onglet.
  TV.settings.onChange(() => schedule(0));

  let lastCheck = 0;
  new MutationObserver(() => {
    const now = Date.now();
    if (now - lastCheck < 600) return;
    lastCheck = now;
    const btn = document.getElementById(BTN_ID);
    const attendu = isWatchPage() && TV.settings.get().transcriptButton;
    if (attendu ? !btn || !btn.isConnected : !!btn) schedule(200);
  }).observe(document.documentElement, { childList: true, subtree: true });

  // On attend les reglages : sans ca, un bouton desactive apparaitrait une
  // fraction de seconde avant d'etre retire.
  TV.settings.ready.then(() => schedule(600));
})();
