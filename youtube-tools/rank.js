'use strict';

/**
 * YouTube Tools — classement sur 10 : panneau dans la colonne de droite.
 *
 * Sur une page de lecture, un panneau est pose en haut de la colonne de droite,
 * juste sous celui de vidIQ s'il est installe (comme Better YouTube Studio). Il
 * dit ou se situe la video regardee parmi les 10 dernieres de sa chaine, a age
 * egal (le calcul est dans rank-core.js), et liste les dix videos. Son en-tete
 * l'enroule ou le deroule ; ce choix est retenu d'une video a l'autre.
 *
 * Les donnees de la video viennent de rank-bridge.js, qui les recopie depuis la
 * page dans l'attribut `data-yttools-rank-src` du document.
 *
 * Contrairement au reste de l'extension, cette fonction EMET des requetes vers
 * YouTube (liste publique des videos de la chaine, sans cookie, en cache 6 h).
 * Le detail et ses justifications sont en tete de rank-core.js. Le reglage
 * « Classement sur 10 » du popup la coupe entierement.
 */

(() => {
  if (window.__yttoolsRankLoaded) return;
  window.__yttoolsRankLoaded = true;

  // Fournis par common.js et rank-core.js, charges avant ce script.
  const TV = window.__yttools;
  const RK = window.__yttoolsRank;
  if (!TV || !RK) { console.warn('[YouTube Tools] common.js ou rank-core.js absent'); return; }

  const CARD_ID = 'yttools-rank-card';
  const SRC = 'data-yttools-rank-src';
  const COLLAPSE_KEY = 'yttoolsRankCollapsed';

  // Icone « classement » de Material Design (licence Apache 2.0).
  const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7.5 21H2V9h5.5v12zm7.25-18h-5.5v18h5.5V3zM22 11h-5.5v10H22V11z"/></svg>';
  const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>';

  let shownFor = '';     // « idVideo|langue » de la video affichee
  let pendingFor = '';   // calcul en cours pour cette meme cle
  let result = null;     // dernier resultat recu pour shownFor
  let seq = 0;           // ecarte les reponses arrivees apres un changement de video
  let collapsed = false;

  try {
    chrome.storage.local.get(COLLAPSE_KEY).then((s) => {
      collapsed = !!(s && s[COLLAPSE_KEY]);
      const el = document.getElementById(CARD_ID);
      if (el) applyCollapsed(el);
    }).catch(() => {});
  } catch { /* contexte d'extension indisponible : deroule par defaut */ }

  const lang = () => document.documentElement.lang || navigator.language || 'fr';
  const videoId = () => new URLSearchParams(location.search).get('v') || '';
  const isWatchPage = () => location.pathname === '/watch' && !!videoId();

  /* ---------------------------------------------------------------- donnees */

  function readSource() {
    let d = null;
    try { d = JSON.parse(document.documentElement.getAttribute(SRC) || 'null'); } catch { d = null; }
    // Le pont peut encore porter la video precedente juste apres une navigation.
    if (!d || d.id !== videoId()) return null;
    const t = Date.parse(d.published || '');
    return { ...d, published: Number.isFinite(t) ? t : null };
  }

  async function launch(key, src) {
    pendingFor = key;
    const mine = ++seq;
    let r;
    try {
      r = await RK.computeRanking(src, {
        // Enveloppe obligatoire : appele comme methode de deps, fetch leverait
        // « Illegal invocation » (son `this` doit etre la fenetre).
        fetch: (url, opts) => fetch(url, opts),
        base: '',                               // adresse relative : meme origine que la page
        cfg: { key: src.key, version: src.version },
        now: Date.now,
        storage: window.sessionStorage,
        lang: lang()
      });
    } catch {
      r = { status: 'error' };
    }
    if (mine !== seq || shownFor !== key) return;
    result = r;
    const el = document.getElementById(CARD_ID);
    if (el) render(el);
  }

  /* -------------------------------------------------------------- emplacement */

  // Conteneurs dans lesquels on accepte de se poser, du plus precis au plus large.
  const CONTAINERS = ['#secondary-inner', '#secondary'];

  // Le bloc des videos suggerees, et la rangee de filtres qui le coiffe.
  const SUGGESTIONS = [
    'YTD-WATCH-NEXT-SECONDARY-RESULTS-RENDERER',
    'YTD-FEED-FILTER-CHIP-BAR-RENDERER'
  ];

  /**
   * L'enfant du conteneur devant lequel se poser : le premier bloc de
   * suggestions. Le panneau atterrit donc juste au-dessus des videos proposees,
   * sous les panneaux des autres extensions.
   *
   * On vise un element de YOUTUBE, pas un element de vidIQ. La version
   * precedente cherchait « le dernier enfant contenant quelque chose de vidIQ »
   * — sauf que vidIQ pose aussi ses badges (VPH, multiplicateur) a l'interieur
   * des cartes suggerees. Le bloc des suggestions correspondait donc, et le
   * panneau se retrouvait apres TOUTE la liste, invisible en bas de colonne.
   */
  function anchorIn(container) {
    for (const child of container.children) {
      if (child.id === CARD_ID) continue;
      if (SUGGESTIONS.includes(child.tagName)) return child;
    }
    return null;
  }

  function containerNow() {
    for (const sel of CONTAINERS) {
      const c = document.querySelector(`ytd-watch-flexy ${sel}`) || document.querySelector(sel);
      if (c) return c;
    }
    return null;
  }

  /** Remet le panneau a sa place si vidIQ est arrive apres lui. Ne bouge rien sinon. */
  function position(el) {
    const c = containerNow();
    if (!c) return;
    const anchor = anchorIn(c);
    if (anchor) {
      if (el.parentElement !== c || el.nextElementSibling !== anchor) anchor.before(el);
    } else if (el.parentElement !== c || c.firstElementChild !== el) {
      // Pas de suggestions reperees : la tete de colonne, au moins c'est visible.
      c.prepend(el);
    }
  }

  /* ----------------------------------------------------------------- panneau */

  function tier(pos, total) {
    if (pos === 1) return 'first';
    if (pos <= 3) return 'top';
    if (pos > total - 3) return 'low';
    return 'mid';
  }

  const ordinal = (n) => (n === 1 ? '1re' : `${n}e`);

  function span(cls, text) {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;                        // textContent : un titre ne devient jamais du HTML
    return s;
  }

  function compact(n) {
    const opts = { notation: 'compact', maximumFractionDigits: 1 };
    try { return new Intl.NumberFormat(lang(), opts).format(Math.round(n)); } catch { return new Intl.NumberFormat('fr', opts).format(Math.round(n)); }
  }

  function formatAge(h) {
    const [unit, size] = h < 24 ? ['hour', 1] : h < 720 ? ['day', 24] : h < 8760 ? ['month', 730] : ['year', 8766];
    const n = Math.max(1, Math.floor(h / size));
    try { return new Intl.NumberFormat(lang(), { style: 'unit', unit, unitDisplay: 'long' }).format(n); } catch { return `${n} ${unit}`; }
  }

  /** Texte de l'en-tete et message du corps, selon le statut. */
  function summary(r) {
    switch (r.status) {
      case 'ok': return { value: `${ordinal(r.position)} sur ${r.total}`, state: tier(r.position, r.total) };
      case 'loading': return { value: '…', state: 'loading', msg: 'Calcul du classement…' };
      case 'too-early': return { value: '< 24 h', state: 'muted', msg: 'Classement disponible 24 heures après la publication.' };
      case 'live': return { value: 'Direct', state: 'muted', msg: 'Pas de classement pour un direct.' };
      case 'not-enough': return { value: '—', state: 'muted', msg: 'La chaîne n’a pas assez de vidéos précédentes pour un classement.' };
      case 'not-found': return { value: '—', state: 'muted', msg: 'Vidéo absente de la liste de la chaîne (trop ancienne ?).' };
      default: return { value: '—', state: 'muted', msg: 'Classement indisponible pour le moment.' };
    }
  }

  function applyCollapsed(el) {
    const v = collapsed ? 'true' : 'false';
    if (el.dataset.collapsed !== v) el.dataset.collapsed = v;
    const head = el.querySelector('.yttools-rk-toggle');
    if (head && head.getAttribute('aria-expanded') !== String(!collapsed)) head.setAttribute('aria-expanded', String(!collapsed));
  }

  function toggle() {
    collapsed = !collapsed;
    const el = document.getElementById(CARD_ID);
    if (el) applyCollapsed(el);
    try { chrome.storage.local.set({ [COLLAPSE_KEY]: collapsed }); } catch { /* reste en memoire pour la session */ }
  }

  function build() {
    const card = document.createElement('section');
    card.id = CARD_ID;
    card.setAttribute('aria-label', 'Classement sur 10');

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'yttools-rk-toggle';
    const icon = document.createElement('span');
    icon.className = 'yttools-rk-icon';
    icon.innerHTML = ICON;                       // constante de ce fichier, jamais une donnee
    const chev = document.createElement('span');
    chev.className = 'yttools-rk-chevron';
    chev.innerHTML = CHEVRON;                    // idem
    head.append(icon, span('yttools-rk-label', 'Classement sur 10'), span('yttools-rk-value', ''), chev);
    head.addEventListener('click', (e) => { e.preventDefault(); toggle(); });

    const body = document.createElement('div');
    body.className = 'yttools-rk-body';

    card.append(head, body);
    applyCollapsed(card);
    return card;
  }

  /** Reconstruit le corps — uniquement quand le resultat change, pas a chaque mutation. */
  function render(el) {
    const r = result || { status: 'loading' };
    const s = summary(r);
    const val = el.querySelector('.yttools-rk-value');
    if (val.textContent !== s.value) val.textContent = s.value;
    if (el.dataset.state !== s.state) el.dataset.state = s.state;

    const stamp = `${shownFor}|${r.status}`;
    if (el.dataset.rendered === stamp) return;
    el.dataset.rendered = stamp;

    const body = el.querySelector('.yttools-rk-body');
    body.textContent = '';
    if (r.status !== 'ok') { body.append(span('yttools-rk-msg', s.msg)); return; }

    const autres = r.total - 1;
    body.append(span('yttools-rk-sub', r.kind === 'short' || r.ageHours == null
      ? `Vues actuelles, comparé aux ${autres} Shorts précédents de la chaîne`
      : `Vues à ${formatAge(r.ageHours)}, comparée aux ${autres} vidéos précédentes de la chaîne`));

    const list = document.createElement('div');
    list.className = 'yttools-rk-list';
    r.entries.forEach((e, i) => {
      const row = document.createElement(e.current ? 'div' : 'a');
      row.className = 'yttools-rk-row' + (e.current ? ' is-current' : '');
      if (!e.current) row.href = `/watch?v=${encodeURIComponent(e.id)}`;
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      if (/^[\w-]{11}$/.test(e.id)) img.src = `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`;
      const title = span('yttools-rk-title', e.title || '');
      title.title = e.title || '';
      const views = span('yttools-rk-views', (e.estimated ? '≈ ' : '') + compact(e.views));
      if (e.estimated) views.title = 'Estimation des vues qu’elle avait probablement au même âge';
      row.append(span('yttools-rk-n', String(i + 1)), img, title, views);
      list.append(row);
    });
    body.append(list);

    if (r.entries.some((e) => e.estimated)) {
      body.append(span('yttools-rk-foot', '≈ estimation au même âge, d’après une courbe de croissance type : la moitié des vues arrive en deux jours.'));
    }
  }

  /** Appele a chaque verification de keepMounted : doit rester tres leger. */
  function refresh(el) {
    position(el);
    TV.applyTheme(el);
    const key = `${videoId()}|${lang()}`;
    if (key !== shownFor) {                      // nouvelle video
      shownFor = key;
      pendingFor = '';
      result = null;
    }
    if (!result && pendingFor !== key) {
      const src = readSource();
      if (src) launch(key, src);                 // sinon : le pont n'a pas encore publie
    }
    render(el);
  }

  function place() {
    const c = containerNow();
    if (!c) return;
    const card = build();
    const anchor = anchorIn(c);
    if (anchor) anchor.before(card); else c.prepend(card);
  }

  // keepMounted ne surveille que l'arborescence ; la publication du pont est un
  // changement d'ATTRIBUT, qu'il faut donc guetter a part.
  new MutationObserver(() => {
    const el = document.getElementById(CARD_ID);
    if (el && isWatchPage()) refresh(el);
  }).observe(document.documentElement, { attributes: true, attributeFilter: [SRC] });

  TV.keepMounted({
    id: CARD_ID,
    wanted: () => isWatchPage() && TV.settings.get().rankBadge,
    place,
    refresh
  });
})();
