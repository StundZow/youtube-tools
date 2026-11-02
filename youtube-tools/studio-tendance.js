'use strict';

/**
 * YouTube Studio — fleches de tendance a cote des vues (page Contenu).
 *
 * Chaque video publique est comparee aux 10 videos publiques publiees juste
 * avant elle, A AGE EGAL : les plus anciennes ayant eu plus de temps, on
 * estime combien de vues chacune avait a l'age de la video comparee, avec la
 * meme courbe de croissance que le classement sur 10 (rank-core.js).
 *
 *   ▲ vert  : plus de vues que les trois quarts d'entre elles ;
 *   ▼ rouge : moins de vues que les trois quarts d'entre elles ;
 *   — gris  : dans la normale.
 *
 * Idee reprise de Better YouTube Studio (SQUIDUU), qui lit les chiffres exacts
 * de Studio avec la session de l'utilisateur. Ici, rien de tel : seuls les
 * chiffres DEJA affiches dans la page servent (date et vues de chaque ligne).
 * Aucune requete, aucun cookie. Revers : une video n'est comparee qu'aux
 * videos visibles sur la meme page de la liste.
 */

(() => {
  if (window.__yttoolsTrend) return;
  const TV = window.__yttools;
  const RK = window.__yttoolsRank;
  if (!TV || !RK) return;

  const CLS = 'yttools-trend';
  const REFS = 10;          // les 10 videos precedentes
  const MIN_REFS = 4;       // en dessous, une « normale » ne veut rien dire
  const MIN_AGE_H = 24;     // avant 24 h, l'estimation est trop instable

  // Icones Material Design (licence Apache 2.0). Construites element par
  // element : Studio impose les Trusted Types (innerHTML refuse dans la page),
  // on ne depend donc jamais d'innerHTML ici.
  const ICONES = {
    up: 'M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z',
    down: 'M20 12l-1.41-1.41L13 16.17V4h-2v12.17l-5.58-5.59L4 12l8 8 8-8z',
    same: 'M19 13H5v-2h14v2z'
  };

  function icone(t) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('fill', 'currentColor');
    p.setAttribute('d', ICONES[t]);
    svg.append(p);
    return svg;
  }
  const LIBELLES = { up: 'Au-dessus de la normale', down: 'En dessous de la normale', same: 'Dans la normale' };

  /* ------------------------------------------------------------- lecture */

  /** « juin » -> 5, « janv. » -> 0, « Dec » -> 11 ; -1 si inconnu. */
  function mois(mot) {
    const m = String(mot).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    if (m.startsWith('juin')) return 5;
    if (m.startsWith('juil')) return 6;
    const T = ['jan', 'feb|fev', 'mar', 'apr|avr', 'may|mai', 'jun', 'jul', 'aug|aou', 'sep', 'oct', 'nov', 'dec'];
    return T.findIndex((p) => p.split('|').some((x) => m.startsWith(x)));
  }

  /** « 13 juin 2026 », « 3 janv. 2026 », « Jun 13, 2026 » -> horodatage (midi, heure locale). */
  function lireDate(texte) {
    const t = String(texte || '').replace(/[  ]/g, ' ').trim();
    let j, mo, a;
    let m = t.match(/(\d{1,2})\.?\s+([^\d\s.,]+)\.?,?\s+(\d{4})/);
    if (m) { j = +m[1]; mo = mois(m[2]); a = +m[3]; }
    else if ((m = t.match(/([^\d\s.,]+)\.?\s+(\d{1,2}),?\s+(\d{4})/))) { j = +m[2]; mo = mois(m[1]); a = +m[3]; }
    if (!m || mo < 0 || !(j >= 1 && j <= 31)) return null;
    return new Date(a, mo, j, 12).getTime();
  }

  /** Le texte propre a une cellule, sans celui de ses enfants (description, fleche). */
  const texteDirect = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join(' ');

  function lireLigne(row) {
    const a = row.querySelector('a#video-title[href*="/video/"], a[href*="/video/"]');
    const id = ((a && a.getAttribute('href')) || '').match(/\/video\/([\w-]{11})/);
    const cellV = row.querySelector('.tablecell-views');
    const cellD = row.querySelector('.tablecell-date');
    if (!id || !cellV || !cellD) return null;
    const brut = texteDirect(cellV);
    const vues = /\d/.test(brut) ? TV.parseCount(brut) : '';
    return {
      id: id[1],
      cell: cellV,
      vues: vues === '' ? null : vues,
      publiee: lireDate(texteDirect(cellD)),
      // L'icone du globe ne depend pas de la langue de Studio, contrairement a « Publique ».
      publique: !!row.querySelector('.tablecell-visibility .privacy-public-icon')
    };
  }

  /* -------------------------------------------------------------- calcul */

  /** id -> { t: up|down|same, bas, haut, n, age } pour chaque video comparable. */
  function tendances(lignes, now) {
    const pub = lignes
      .filter((l) => l.publique && l.vues != null && l.publiee != null)
      .sort((a, b) => b.publiee - a.publiee);       // tri stable : a date egale, l'ordre de Studio
    const out = new Map();
    pub.forEach((l, i) => {
      const age = (now - l.publiee) / 3600e3;
      if (age < MIN_AGE_H) return;
      const refs = pub.slice(i + 1, i + 1 + REFS);
      if (refs.length < MIN_REFS) return;
      const g = RK.growth(age);
      const est = refs
        .map((r) => r.vues * g / RK.growth(Math.max(age, (now - r.publiee) / 3600e3)))
        .sort((a, b) => a - b);
      const q = (p) => est[Math.min(est.length - 1, Math.floor(est.length * p))];
      const bas = q(0.25);
      const haut = q(0.75);
      out.set(l.id, { t: l.vues > haut ? 'up' : l.vues < bas ? 'down' : 'same', bas, haut, n: refs.length, age });
    });
    return out;
  }

  /* ------------------------------------------------------------- affichage */

  function compact(n) {
    try { return new Intl.NumberFormat('fr', { notation: 'compact', maximumFractionDigits: 1 }).format(Math.round(n)); } catch { return String(Math.round(n)); }
  }

  function dureeLisible(h) {
    const [u, s] = h < 24 * 14 ? ['jour', 24] : h < 24 * 60 ? ['semaine', 168] : h < 8766 ? ['mois', 730] : ['an', 8766];
    const n = Math.max(1, Math.floor(h / s));
    return `${n} ${u}${n > 1 && u !== 'mois' ? 's' : ''}`;
  }

  function poser(cell, id, r) {
    const ex = cell.querySelector('.' + CLS);
    if (!r) { if (ex) ex.remove(); return; }
    // Signature sur les valeurs AFFICHEES (arrondies) : les estimations bougent
    // un peu a chaque seconde avec l'age, la fleche ne doit pas etre refaite pour ca.
    const sig = `${id}|${r.t}|${compact(r.bas)}|${compact(r.haut)}|${r.n}|${dureeLisible(r.age)}`;
    if (ex && ex.dataset.sig === sig) return;
    if (ex) ex.remove();
    const s = document.createElement('span');
    s.className = CLS;
    s.dataset.trend = r.t;
    s.dataset.sig = sig;
    s.setAttribute('role', 'img');
    s.setAttribute('aria-label', LIBELLES[r.t]);
    s.title = `${LIBELLES[r.t]}\nD'habitude ${compact(r.bas)} – ${compact(r.haut)} vues à ${dureeLisible(r.age)}`
      + `\n(estimation d'après les ${r.n} vidéos précédentes de la liste)`;
    s.append(icone(r.t));
    cell.append(s);
  }

  const surContenu = () => /^\/channel\/UC[\w-]{22}\/videos(\/|$)/.test(location.pathname);

  function maj() {
    const on = TV.settings.get().viewsTrend !== false && surContenu();
    if (!on) {
      document.querySelectorAll('.' + CLS).forEach((n) => n.remove());
      return;
    }
    const lignes = Array.from(document.querySelectorAll('ytcp-video-row')).map(lireLigne).filter(Boolean);
    const res = tendances(lignes, Date.now());
    for (const l of lignes) poser(l.cell, l.id, res.get(l.id));
  }

  // La liste se reconstruit (pagination, tri, filtres) : on suit les mutations,
  // regroupees, plus une verification lente pour ce qui arriverait en silence.
  let prevu = false;
  new MutationObserver(() => {
    if (prevu) return;
    prevu = true;
    setTimeout(() => { prevu = false; maj(); }, 250);
  }).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(maj, 2000);
  TV.settings.onChange(maj);
  TV.settings.ready.then(maj);

  window.__yttoolsTrend = { lireDate, lireLigne, tendances, maj };
})();
