'use strict';

/**
 * YouTube Studio — zoom dans le graphique de retention.
 *
 * Le graphique reste a sa place et garde sa taille : c'est la COURBE qui
 * zoome. Molette vers le haut sur le graphique : on zoome a l'endroit pointe.
 * Molette vers le bas : on dezoome. Glisser (ou Maj + molette) : on se
 * deplace. Double-clic : retour a la vue d'origine.
 *
 * Zoome, l'echelle des pourcentages s'adapte a la portion visible : une baisse
 * de 2 points, invisible sur l'echelle 0-100 %, devient lisible. Les points de
 * mesure apparaissent des qu'ils sont assez espaces, un survol donne l'instant
 * et le pourcentage, et le trait de lecture suit la video du lecteur de la
 * carte (la vue se decale quand il atteint le bord).
 *
 * Studio ne laisse pas les donnees de la courbe a portee d'une extension :
 * comme Better YouTube Studio (SQUIDUU), dont l'idee est reprise, on relit les
 * points du trace SVG, et on redessine la portion zoomee par-dessus, dans le
 * meme <svg>. Le graphique de Studio n'est jamais modifie, seulement masque
 * pendant le zoom. Aucune requete.
 */

(() => {
  if (window.__yttoolsRetention) return;
  const TV = window.__yttools;
  if (!TV) return;

  const NS = 'http://www.w3.org/2000/svg';
  const ON = 'yttools-rz-on';             // sur le <svg> zoome
  const LAYER = 'yttools-rz-layer';
  const MOLETTE = 0.0022;                 // 100 px de molette = x1,25
  const etats = new WeakMap();            // <svg> -> etat du zoom
  const zoomes = new Set();               // etats actuellement zoomes
  let uid = 0;

  const actif = () => TV.settings.get().retentionZoom !== false;
  const surStats = () => /\/analytics(\/|$)/.test(location.pathname);

  /* -------------------------------------------------------------- lecture */

  function estRetention(svg) {
    for (let n = svg; n; n = n.parentElement) {
      if (/retention/i.test(n.tagName || '') || /retention/i.test(n.id || '')) return true;
    }
    return false;
  }

  const nombre = (s) => {
    const m = String(s).replace(/[\s  ]/g, '').replace(',', '.').match(/-?\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  };

  const translation = (el) => {
    const m = ((el && el.getAttribute('transform')) || '').match(/translate\(\s*(-?[\d.]+)(?:[\s,]+(-?[\d.]+))?/);
    return m ? [parseFloat(m[1]), parseFloat(m[2] || 0)] : [0, 0];
  };

  const secondes = (s) => {
    const m = String(s).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
    return m ? Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
  };

  /**
   * Geometrie et donnees du graphique : zone de trace, taille, duree de la
   * video et, pour chaque courbe, ses points en (t = fraction de la duree,
   * r = pourcentage). Null si le graphique n'est pas (encore) lisible.
   */
  function lire(svg) {
    const zone = svg.querySelector('g.aplos-draw-area');
    const traces = Array.from(svg.querySelectorAll('path.line-series')).filter((p) => (p.getAttribute('d') || '').length > 20);
    if (!zone || !traces.length) return null;

    const brutes = traces.map((p) => ({
      couleur: p.getAttribute('stroke') || 'currentColor',
      pts: ((p.getAttribute('d') || '').match(/-?[\d.]+,-?[\d.]+/g) || []).map((c) => c.split(',').map(Number))
    })).filter((s) => s.pts.length >= 3);
    if (!brutes.length) return null;

    const pane = svg.querySelector('rect.mouseCapturePane');
    const w = (pane && parseFloat(pane.getAttribute('width'))) || Math.max(...brutes.flatMap((s) => s.pts.map((p) => p[0])));
    const h = (pane && parseFloat(pane.getAttribute('height'))) || 160;
    if (!(w > 0) || !(h > 0)) return null;

    // Axe des pourcentages : deux graduations suffisent a passer des pixels aux %.
    // (Une retention peut depasser 100 % : on ne suppose donc pas 0-100.)
    const axe = svg.querySelector('g.y2.axis g.tick') ? 'g.y2.axis' : 'g.y.axis';
    const gy = Array.from(svg.querySelectorAll(`${axe} g.tick`))
      .map((g) => ({ y: translation(g)[1], v: nombre(g.textContent) }))
      .filter((t) => t.v != null);
    let pct = (y) => 100 * (1 - y / h);
    if (gy.length >= 2 && gy[0].y !== gy[gy.length - 1].y) {
      const a = gy[0];
      const b = gy[gy.length - 1];
      pct = (y) => a.v + (y - a.y) * (b.v - a.v) / (b.y - a.y);
    }

    // Duree : la graduation horaire la plus a droite (« 20:42 » au bout de l'axe).
    const gx = Array.from(svg.querySelectorAll('g.x.axis g.tick'))
      .map((g) => ({ x: translation(g)[0], s: secondes(g.textContent) }))
      .filter((t) => t.s != null && t.x > 0)
      .sort((a, b) => b.x - a.x);
    const duree = gx.length ? gx[0].s * w / gx[0].x : 0;

    const series = brutes.map((s) => {
      const vals = [];
      for (const [x, y] of s.pts) {
        const t = x / w;
        const prec = vals[vals.length - 1];
        if (prec && prec.t === t) prec.r = pct(y); else vals.push({ t, r: pct(y) });
      }
      return { couleur: s.couleur, vals };
    });

    return { zone, w, h, duree, series, sig: traces.map((p) => p.getAttribute('d')).join('|') + `|${w}x${h}` };
  }

  /** Valeur d'une courbe a l'instant t, par interpolation lineaire. */
  function valeur(vals, t) {
    if (t <= vals[0].t) return vals[0].r;
    for (let i = 1; i < vals.length; i++) {
      if (vals[i].t >= t) {
        const a = vals[i - 1];
        const b = vals[i];
        return b.t === a.t ? b.r : a.r + (b.r - a.r) * (t - a.t) / (b.t - a.t);
      }
    }
    return vals[vals.length - 1].r;
  }

  /* -------------------------------------------------------------- dessin */

  function svgEl(tag, attrs, parent) {
    const n = document.createElementNS(NS, tag);
    for (const k of Object.keys(attrs)) n.setAttribute(k, attrs[k]);
    if (parent) parent.append(n);
    return n;
  }

  const lang = () => document.documentElement.lang || 'fr';

  function fmtPct(v, dec) {
    try { return new Intl.NumberFormat(lang(), { style: 'percent', minimumFractionDigits: dec, maximumFractionDigits: dec }).format(v / 100); } catch { return `${v.toFixed(dec)} %`; }
  }

  function fmtTemps(s) {
    const t = Math.max(0, Math.round(s));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const p2 = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${p2(m)}:${p2(t % 60)}` : `${m}:${p2(t % 60)}`;
  }

  const fmtFacteur = (k) => (k < 10 ? k.toFixed(1).replace('.', ',').replace(',0', '') : String(Math.round(k)));

  /** Pas « rond » (1, 2, 2,5, 5 x 10^n) donnant environ `cible` graduations. */
  function pasRond(etendue, cible) {
    const brut = etendue / cible;
    const p = 10 ** Math.floor(Math.log10(brut));
    return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= brut) || p * 10;
  }

  function dessiner(st) {
    const { g, view: v } = st;
    if (!st.layer || st.layer.parentNode !== g.zone) {
      if (st.layer) st.layer.remove();
      st.layer = svgEl('g', { class: LAYER }, g.zone);
    }
    const L = st.layer;
    while (L.firstChild) L.firstChild.remove();
    const { w, h } = g;
    const span = v.to - v.from;

    // Echelle verticale ajustee a la portion visible, avec un peu d'air.
    const vis = [];
    for (const s of g.series) {
      for (const p of s.vals) if (p.t >= v.from && p.t <= v.to) vis.push(p.r);
      vis.push(valeur(s.vals, v.from), valeur(s.vals, v.to));
    }
    let lo = Math.min(...vis);
    let hi = Math.max(...vis);
    const air = Math.max(0.5, (hi - lo) * 0.12);
    lo = Math.max(0, lo - air);
    hi += air;
    if (hi - lo < 2) { lo = Math.max(0, (hi + lo) / 2 - 1); hi = lo + 2; }
    const X = (t) => (t - v.from) / span * w;
    const Y = (r) => (1 - (r - lo) / (hi - lo)) * h;
    Object.assign(st, { X, Y });

    // Surface qui recoit la souris (transparente) : le graphique de Studio est masque.
    svgEl('rect', { x: 0, y: 0, width: w, height: h, class: 'yttools-rz-fond' }, L);

    const pas = pasRond(hi - lo, 4);
    // Un pas de 2,5 ou de 0,5 exige une decimale, sinon « 42,5 % » s'affiche « 43 % ».
    st.dec = Number.isInteger(Math.round(pas * 1000) / 1000) ? 0 : 1;
    for (let r = Math.ceil(lo / pas) * pas; r <= hi + 1e-9; r += pas) {
      const y = Y(r);
      svgEl('line', { x1: 0, x2: w, y1: y, y2: y, class: 'yttools-rz-grille' }, L);
      svgEl('text', { x: w + 16, y, dy: '.32em', class: 'yttools-rz-txt' }, L).textContent = fmtPct(r, st.dec);
    }

    svgEl('line', { x1: 0, x2: w, y1: h, y2: h, class: 'yttools-rz-axe' }, L);
    for (let i = 0; i <= 4; i++) {
      const t = v.from + span * i / 4;
      const x = X(t);
      svgEl('line', { x1: x, x2: x, y1: h, y2: h + 6, class: 'yttools-rz-axe' }, L);
      svgEl('text', {
        x, y: h + 12, dy: '.71em', class: 'yttools-rz-txt',
        'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle'
      }, L).textContent = g.duree ? fmtTemps(t * g.duree) : fmtPct(t * 100, 0);
    }

    const clip = `yttools-rz-clip-${st.id}`;
    svgEl('rect', { x: 0, y: -2, width: w, height: h + 4 }, svgEl('clipPath', { id: clip }, svgEl('defs', {}, L)));
    for (const s of g.series) {
      const dedans = s.vals.filter((p) => p.t > v.from && p.t < v.to);
      const pts = [{ t: v.from, r: valeur(s.vals, v.from) }, ...dedans, { t: v.to, r: valeur(s.vals, v.to) }];
      svgEl('path', {
        d: 'M' + pts.map((p) => `${X(p.t).toFixed(1)},${Y(p.r).toFixed(1)}`).join('L'),
        fill: 'none', stroke: s.couleur, 'stroke-width': 2, 'stroke-linejoin': 'round',
        'clip-path': `url(#${clip})`, class: 'yttools-rz-courbe'
      }, L);
      // Les points de mesure, des qu'ils sont assez espaces pour etre distingues.
      if (dedans.length && w / dedans.length >= 12) {
        for (const p of dedans) svgEl('circle', { cx: X(p.t), cy: Y(p.r), r: 2.5, fill: s.couleur, class: 'yttools-rz-point' }, L);
      }
    }

    svgEl('text', { x: w, y: -5, 'text-anchor': 'end', class: 'yttools-rz-info' }, L)
      .textContent = `Zoom ×${fmtFacteur(1 / span)} · double-clic pour revenir`;
    st.tete = svgEl('g', { class: 'yttools-rz-tete' }, L);
    st.survol = svgEl('g', { class: 'yttools-rz-survol' }, L);
    teteDeLecture(st);
  }

  /** Infobulle du survol : trait vertical, point sur chaque courbe, instant et valeur. */
  function survoler(st, fx) {
    const S = st.survol;
    if (!S) return;
    while (S.firstChild) S.firstChild.remove();
    if (fx == null) return;
    const { g, view: v } = st;
    const t = v.from + fx * (v.to - v.from);
    const x = st.X(t);
    svgEl('line', { x1: x, x2: x, y1: 0, y2: g.h, class: 'yttools-rz-repere' }, S);
    const valeurs = g.series.map((s) => {
      const r = valeur(s.vals, t);
      svgEl('circle', { cx: x, cy: st.Y(r), r: 4, fill: s.couleur, class: 'yttools-rz-repere-point' }, S);
      return r;
    });
    const texte = `${g.duree ? fmtTemps(t * g.duree) : ''}  ${valeurs.map((r) => fmtPct(r, st.dec)).join(' · ')}`.trim();
    const largeur = texte.length * 7 + 16;
    const bx = x + 10 + largeur > g.w ? x - 10 - largeur : x + 10;
    const bulle = svgEl('g', { class: 'yttools-rz-bulle' }, S);
    svgEl('rect', { x: bx, y: 4, width: largeur, height: 24, rx: 6 }, bulle);
    svgEl('text', { x: bx + 8, y: 16, dy: '.35em' }, bulle).textContent = texte;
  }

  /* ------------------------------------------------------------ la video */

  /** Le lecteur de la carte de retention (Studio y joue la video a cote du graphique). */
  function videoDe(st) {
    let trouvee = null;
    for (let n = st.svg.parentElement; n; n = n.parentElement) {
      if (/retention/i.test(n.tagName || '')) trouvee = n.querySelector('video') || trouvee;
    }
    return trouvee;
  }

  function teteDeLecture(st) {
    const T = st.tete;
    if (!T || !st.view) return;
    while (T.firstChild) T.firstChild.remove();
    const vid = videoDe(st);
    const duree = vid && vid.duration > 0 ? vid.duration : st.g.duree;
    if (!vid || !(duree > 0)) return;
    const tt = vid.currentTime / duree;
    const { from, to } = st.view;
    const span = to - from;
    // Pendant la lecture, la vue suit : arrive au bord droit, elle se decale.
    if (!vid.paused && !vid.ended && to < 1 && tt >= to - span * 0.02 && tt < to + span * 0.5) {
      const debut = Math.min(1 - span, tt - span * 0.1);
      vue(st, { from: debut, to: debut + span });
      return;
    }
    if (tt < from || tt > to) return;
    const x = st.X(tt);
    svgEl('line', { x1: x, x2: x, y1: 0, y2: st.g.h, class: 'yttools-rz-lecture' }, T);
  }

  /* ---------------------------------------------------------------- vue */

  function vue(st, v) {
    st.view = v;
    st.svg.classList.add(ON);
    zoomes.add(st);
    dessiner(st);
  }

  function reinitialiser(st) {
    st.view = null;
    st.glisse = null;
    st.svg.classList.remove(ON);
    if (st.layer) st.layer.remove();
    st.layer = null;
    zoomes.delete(st);
  }

  /** Position de la souris dans la zone de trace : fraction horizontale, ou null hors zone. */
  function pointeur(st, e) {
    const cible = (st.layer && st.layer.querySelector('.yttools-rz-fond')) || st.svg.querySelector('rect.mouseCapturePane');
    if (!cible) return null;
    const r = cible.getBoundingClientRect();
    if (!(r.width > 0)) return null;
    const fx = (e.clientX - r.left) / r.width;
    // Un peu de marge sous la zone : l'axe du temps compte comme le graphique.
    if (fx < 0 || fx > 1 || e.clientY < r.top || e.clientY > r.bottom + 24) return null;
    return { fx, largeur: r.width };
  }

  function decaler(st, delta) {
    const { from, to } = st.view;
    const span = to - from;
    const debut = Math.min(Math.max(0, from + delta), 1 - span);
    if (debut !== from) vue(st, { from: debut, to: debut + span });
  }

  function surMolette(st, e) {
    if (!actif()) return;
    const p = pointeur(st, e);
    if (!p) return;
    const v = st.view;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
      if (!v) return;
      e.preventDefault();
      e.stopPropagation();
      decaler(st, (e.shiftKey ? e.deltaY || e.deltaX : e.deltaX) / p.largeur * (v.to - v.from));
      return;
    }
    if (!e.deltaY) return;
    // Pas de zoom en cours et molette vers le bas : on laisse la page defiler.
    if (!v && e.deltaY > 0) return;
    e.preventDefault();
    e.stopPropagation();

    if (!v) st.g = lire(st.svg);
    if (!st.g) return;
    const cur = v || { from: 0, to: 1 };
    const nbPts = Math.max(...st.g.series.map((s) => s.vals.length));
    const mini = Math.max(0.005, 6 / Math.max(6, nbPts));
    const k = Math.min(2, Math.max(0.5, Math.exp(e.deltaY * MOLETTE)));
    const span = Math.max(mini, Math.min(1, (cur.to - cur.from) * k));
    if (span >= 0.999) { reinitialiser(st); return; }
    const t = cur.from + p.fx * (cur.to - cur.from);    // l'instant pointe reste sous la souris
    const debut = Math.min(Math.max(0, t - p.fx * span), 1 - span);
    vue(st, { from: debut, to: debut + span });
  }

  function brancher(st) {
    const hote = st.svg.parentElement || st.svg;
    // Ecoute en CAPTURE sur le parent : on passe avant les ecouteurs du
    // graphique de Studio, qui ne voient donc rien pendant le zoom.
    const opt = { capture: true };

    hote.addEventListener('wheel', (e) => surMolette(st, e), { capture: true, passive: false });

    hote.addEventListener('mousedown', (e) => {
      if (!st.view || e.button !== 0) return;
      const p = pointeur(st, e);
      if (!p) return;
      e.preventDefault();
      e.stopPropagation();
      st.glisse = { x: e.clientX, from: st.view.from, largeur: p.largeur, bouge: false };
      enGlisse = st;
    }, opt);

    hote.addEventListener('mousemove', (e) => {
      if (!st.view) return;
      e.stopPropagation();
      if (st.glisse) return;
      const p = pointeur(st, e);
      survoler(st, p ? p.fx : null);
    }, opt);

    hote.addEventListener('mouseleave', () => { if (st.view) survoler(st, null); });

    // Zoome, un clic place la lecture a l'instant pointe (comme le graphique
    // d'origine) ; apres un glisser, il ne fait rien.
    hote.addEventListener('click', (e) => {
      if (!st.view) return;
      e.preventDefault();
      e.stopPropagation();
      if (st.apresGlisse) { st.apresGlisse = false; return; }
      const p = pointeur(st, e);
      const vid = videoDe(st);
      if (!p || !vid || !(vid.duration > 0)) return;
      vid.currentTime = (st.view.from + p.fx * (st.view.to - st.view.from)) * vid.duration;
      teteDeLecture(st);
    }, opt);

    hote.addEventListener('dblclick', (e) => {
      if (!st.view) return;
      e.preventDefault();
      e.stopPropagation();
      reinitialiser(st);
    }, opt);
  }

  // Le glisser se suit sur la fenetre, en capture : il continue hors du
  // graphique, et passe avant l'ecouteur du graphique, qui arrete la propagation.
  let enGlisse = null;
  window.addEventListener('mousemove', (e) => {
    const st = enGlisse;
    const gl = st && st.glisse;
    if (!gl || !st.view) return;
    const dx = e.clientX - gl.x;
    if (Math.abs(dx) > 3) gl.bouge = true;
    const span = st.view.to - st.view.from;
    decaler(st, gl.from - dx / gl.largeur * span - st.view.from);
  }, true);
  window.addEventListener('mouseup', () => {
    const st = enGlisse;
    enGlisse = null;
    if (!st || !st.glisse) return;
    st.apresGlisse = st.glisse.bouge;
    st.glisse = null;
  }, true);

  /* ---------------------------------------------------------- surveillance */

  function scan() {
    if (!actif() || !surStats()) {
      for (const st of Array.from(zoomes)) reinitialiser(st);
      if (!actif()) return;
    }
    document.querySelectorAll('svg.aplos-chart-svg').forEach((svg) => {
      if (!estRetention(svg)) return;
      let st = etats.get(svg);
      if (!st) {
        st = { id: ++uid, svg, view: null, layer: null, g: null };
        etats.set(svg, st);
        brancher(st);
      }
      if (!st.view) return;
      // Studio a redessine son graphique (taille, periode, onglet) : on relit et on redessine.
      const g = lire(svg);
      if (!g) { reinitialiser(st); return; }
      if (g.sig !== st.g.sig || g.zone !== st.g.zone || !st.layer || !st.layer.isConnected) {
        st.g = g;
        dessiner(st);
      }
    });
    for (const st of Array.from(zoomes)) if (!st.svg.isConnected) zoomes.delete(st);
  }

  let prevu = false;
  new MutationObserver(() => {
    if (prevu) return;
    prevu = true;
    setTimeout(() => { prevu = false; scan(); }, 250);
  }).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(scan, 1000);
  setInterval(() => { for (const st of zoomes) teteDeLecture(st); }, 300);
  TV.settings.onChange(scan);
  TV.settings.ready.then(scan);

  window.__yttoolsRetention = { lire, valeur, pasRond, etats, scan };
})();
