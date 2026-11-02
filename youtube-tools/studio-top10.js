'use strict';

/**
 * YouTube Studio — classement sur 10, separe entre videos et Shorts.
 *
 * Sur le tableau de bord, la carte « Performances de la derniere video »
 * recoit un bloc a deux onglets, Videos et Shorts. Chacun classe le dernier
 * contenu de ce format parmi les 10 derniers du MEME format, a age egal : une
 * video n'est plus comparee a des Shorts, ni l'inverse. Idee reprise de Better
 * YouTube Studio (SQUIDUU), qui ajoute ces onglets a la meme carte.
 *
 * Le calcul est celui du classement de la page de lecture (rank-core.js) :
 * listes PUBLIQUES de la chaine, sans cookie, sans toucher a la session (la ou
 * SQUIDUU lit les chiffres exacts de Studio avec la session). Ce sont donc des
 * estimations, proches de celles de Studio sans leur etre identiques.
 *
 * Requetes : 1 ou 2 par onglet ouvert, gardees en cache. Seul l'onglet affiche
 * est calcule. Le reglage « Classement sur 10 » du popup coupe tout.
 */

(() => {
  if (window.__yttoolsTop10) return;
  const TV = window.__yttools;
  const RK = window.__yttoolsRank;
  if (!TV || !RK) return;

  const ID = 'yttools-top10';
  // Version du client web public : Studio n'a que la sienne (WEB_CREATOR).
  const WEB_VERSION = '2.20251101.00.00';
  const ONGLET_KEY = 'yttoolsTop10Onglet';
  const FORMATS = [['video', 'Vidéos'], ['short', 'Shorts']];

  let onglet = 'video';
  const resultats = new Map();             // « chaine|format » -> resultat

  try {
    chrome.storage.local.get(ONGLET_KEY).then((s) => {
      if (s && (s[ONGLET_KEY] === 'video' || s[ONGLET_KEY] === 'short')) onglet = s[ONGLET_KEY];
      const el = document.getElementById(ID);
      if (el) rafraichir(el);
    }).catch(() => {});
  } catch { /* contexte d'extension indisponible : onglet Videos par defaut */ }

  const lang = () => document.documentElement.lang || navigator.language || 'fr';
  const chaine = () => (location.pathname.match(/^\/channel\/(UC[\w-]{22})(?:\/dashboard)?\/?$/) || [])[1] || '';

  /** La carte « Performances de la derniere video » du tableau de bord. */
  const carte = () => document.querySelector('ytcd-entity-snapshot-item #video-snapshot');

  /* ---------------------------------------------------------------- donnees */

  async function charger(ch, format) {
    const cle = `${ch}|${format}`;
    if (resultats.has(cle)) return;
    resultats.set(cle, { status: 'loading' });
    let r;
    try {
      r = await RK.computeLatest(ch, format, {
        // Enveloppe obligatoire : appele comme methode, fetch leverait « Illegal invocation ».
        fetch: (url, opts) => fetch(url, opts),
        base: 'https://www.youtube.com',
        cfg: { key: '', version: WEB_VERSION },
        now: Date.now,
        storage: window.sessionStorage,
        lang: lang()
      });
    } catch {
      r = { status: 'error' };
    }
    resultats.set(cle, r);
    const el = document.getElementById(ID);
    if (el) rendre(el);
  }

  /* --------------------------------------------------------------- affichage */

  const ordinal = (n) => (n === 1 ? '1re' : `${n}e`);

  function span(cls, texte) {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = texte;                       // textContent : un titre ne devient jamais du HTML
    return s;
  }

  function compact(n) {
    const o = { notation: 'compact', maximumFractionDigits: 1 };
    try { return new Intl.NumberFormat(lang(), o).format(Math.round(n)); } catch { return new Intl.NumberFormat('fr', o).format(Math.round(n)); }
  }

  function age(h) {
    const [u, s] = h < 24 ? ['heure', 1] : h < 24 * 14 ? ['jour', 24] : h < 24 * 60 ? ['semaine', 168] : h < 8766 ? ['mois', 730] : ['an', 8766];
    const n = Math.max(1, Math.floor(h / s));
    return `${n} ${u}${n > 1 && u !== 'mois' ? 's' : ''}`;
  }

  function niveau(pos, total) {
    if (pos === 1) return 'first';
    if (pos <= 3) return 'top';
    if (pos > total - 3) return 'low';
    return 'mid';
  }

  const MESSAGES = {
    video: {
      'too-early': 'Dernière vidéo publiée il y a moins de 24 h : classement disponible ensuite.',
      empty: 'Aucune vidéo publique sur la chaîne.',
      'not-enough': 'Pas assez de vidéos précédentes pour un classement.'
    },
    short: {
      'too-early': 'Dernier Short publié il y a moins de 24 h : classement disponible ensuite.',
      empty: 'Aucun Short public sur la chaîne.',
      'not-enough': 'Pas assez de Shorts précédents pour un classement.'
    }
  };

  function message(r, format) {
    if (r.status === 'loading') return 'Calcul du classement…';
    return MESSAGES[format][r.status] || 'Classement indisponible pour le moment.';
  }

  function construire() {
    const sec = document.createElement('section');
    sec.id = ID;
    sec.setAttribute('aria-label', 'Classement sur 10, vidéos et Shorts séparés');

    const tete = document.createElement('div');
    tete.className = 'yttools-t10-tete';
    tete.append(span('yttools-t10-titre', 'Classement sur 10'));

    const onglets = document.createElement('div');
    onglets.className = 'yttools-t10-onglets';
    onglets.setAttribute('role', 'tablist');
    for (const [format, libelle] of FORMATS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.dataset.format = format;
      b.textContent = libelle;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        if (onglet === format) return;
        onglet = format;
        try { chrome.storage.local.set({ [ONGLET_KEY]: format }); } catch { /* garde en memoire */ }
        rafraichir(sec);
      });
      onglets.append(b);
    }
    tete.append(onglets);

    const corps = document.createElement('div');
    corps.className = 'yttools-t10-corps';
    corps.setAttribute('role', 'tabpanel');
    sec.append(tete, corps);
    return sec;
  }

  /** Reconstruit le corps — uniquement quand le resultat affiche change. */
  function rendre(el) {
    el.querySelectorAll('.yttools-t10-onglets button').forEach((b) => {
      const oui = String(b.dataset.format === onglet);
      if (b.getAttribute('aria-selected') !== oui) b.setAttribute('aria-selected', oui);
    });

    const r = resultats.get(`${chaine()}|${onglet}`) || { status: 'loading' };
    const stamp = `${chaine()}|${onglet}|${r.status}|${r.position || ''}`;
    if (el.dataset.rendered === stamp) return;
    el.dataset.rendered = stamp;
    el.dataset.state = r.status === 'ok' ? niveau(r.position, r.total) : 'muted';

    const corps = el.querySelector('.yttools-t10-corps');
    corps.textContent = '';
    if (r.status !== 'ok') { corps.append(span('yttools-t10-msg', message(r, onglet))); return; }

    const court = onglet === 'short';
    const resume = document.createElement('div');
    resume.className = 'yttools-t10-resume';
    resume.append(span('yttools-t10-quoi', court ? 'Dernier Short' : 'Dernière vidéo'),
      span('yttools-t10-rang', `${ordinal(r.position)} sur ${r.total}`));
    const autres = r.total - 1;
    corps.append(resume, span('yttools-t10-sous', court || r.ageHours == null
      ? `Vues actuelles, comparé aux ${autres} Shorts précédents · estimation, données publiques`
      : `Vues à ${age(r.ageHours)}, comparée aux ${autres} vidéos précédentes · estimation, données publiques`));

    const liste = document.createElement('div');
    liste.className = 'yttools-t10-liste';
    r.entries.forEach((e, i) => {
      const ligne = document.createElement('a');
      ligne.className = 'yttools-t10-ligne' + (e.current ? ' is-current' : '');
      if (/^[\w-]{11}$/.test(e.id)) ligne.href = `/video/${e.id}/analytics/tab-overview/period-default`;
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      if (/^[\w-]{11}$/.test(e.id)) img.src = `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`;
      const titre = span('yttools-t10-nom', e.title || '');
      titre.title = e.title || '';
      const vues = span('yttools-t10-vues', (e.estimated ? '≈ ' : '') + compact(e.views));
      if (e.estimated) vues.title = 'Estimation des vues qu’elle avait probablement au même âge';
      ligne.append(span('yttools-t10-n', String(i + 1)), img, titre, vues);
      liste.append(ligne);
    });
    corps.append(liste);
  }

  function rafraichir(el) {
    const ch = chaine();
    if (ch && !resultats.has(`${ch}|${onglet}`)) charger(ch, onglet);
    rendre(el);
  }

  function placer() {
    const c = carte();
    if (!c) return;
    const sec = construire();
    const boutons = c.querySelector('#link-button-container');
    if (boutons && boutons.parentElement === c) boutons.before(sec); else c.append(sec);
  }

  TV.keepMounted({
    id: ID,
    wanted: () => !!chaine() && TV.settings.get().rankBadge !== false && !!carte(),
    place: placer,
    refresh: rafraichir
  });
})();
