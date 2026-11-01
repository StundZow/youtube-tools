'use strict';

/**
 * YouTube Tools — resume d'une video par Gemini, affiche DANS YouTube.
 *
 * Une fois la transcription copiee (bouton ☰), un bouton « Resumer » apparait
 * a cote. Il envoie la transcription a Gemini (voir background.js) et affiche
 * la reponse en tete de la colonne de droite : on la lit en regardant la video,
 * chaque timecode est cliquable, et le point en cours de lecture est surligne.
 *
 * Le temps du resume, le classement sur 10 et le panneau de vidIQ s'effacent
 * pour que le resume soit cote a cote avec la video — sur CETTE video
 * seulement : les suivantes les retrouvent.
 *
 * Ce fichier expose aussi, via TV.ai, l'interface commune aux resumes (carte,
 * rendu des blocs, envoi a Gemini) : comments.js s'en sert pour le resume des
 * commentaires.
 *
 * Le texte de Gemini n'est jamais insere comme HTML : chaque bloc est
 * reconstruit avec textContent, seuls les timecodes devenant des liens.
 */

(() => {
  if (window.__yttoolsSummaryLoaded) return;
  window.__yttoolsSummaryLoaded = true;

  const TV = window.__yttools;
  if (!TV) { console.warn('[YouTube Tools] common.js absent'); return; }

  const BTN_ID = 'yttools-summary-btn';
  const CARD_ID = 'yttools-summary-card';
  const TR_BTN_ID = 'yttools-transcript-btn';
  const RANK_ID = 'yttools-rank-card';
  const HIDDEN = 'data-yttools-hidden';

  const videoId = () => new URLSearchParams(location.search).get('v') || '';
  const isWatchPage = () => location.pathname === '/watch' && !!videoId();

  const cache = new Map();          // id -> blocs : rouvrir ne redemande rien a Gemini
  let panneau = null;               // { id, status: 'loading' | 'ok' | 'error', blocks, error }

  /* -------------------------------------------------------------- timecodes */

  const TS_RE = /\[?\b((?:\d{1,2}:)?\d{1,2}:[0-5]\d)\b\]?/g;
  const A_UN_TS = /\b(?:\d{1,2}:)?\d{1,2}:[0-5]\d\b/;
  const secondes = (ts) => ts.split(':').reduce((a, p) => a * 60 + Number(p), 0);
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  function fmt(sec, withHours) {
    const s = Math.max(0, Math.round(sec));
    const p2 = (n) => String(n).padStart(2, '0');
    return withHours
      ? Math.floor(s / 3600) + ':' + p2(Math.floor((s % 3600) / 60)) + ':' + p2(s % 60)
      : Math.floor(s / 60) + ':' + p2(s % 60);
  }

  const video = () =>
    document.querySelector('video.html5-main-video') ||
    document.querySelector('#movie_player video') ||
    document.querySelector('video');

  function duree() {
    const v = video();
    if (v && Number.isFinite(v.duration) && v.duration > 0) return v.duration;
    const tr = TV.lastTranscript;
    return tr && tr.meta && Number(tr.meta.duree_s) > 0 ? Number(tr.meta.duree_s) : null;
  }

  function aller(sec) {
    const v = video();
    if (!v) return;
    v.currentTime = sec;
    try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch { /* lecture refusee */ }
  }

  /* ---------------------------------------------- transcription -> tranches */

  /**
   * Segments regroupes par tranches d'au moins 20 s, un timecode par tranche.
   * Une video d'une heure compte un millier de segments : les taper un par un
   * dans Gemini prendrait du temps pour aucun gain sur le resume.
   */
  function tranches(rows, pas = 20) {
    const out = [];
    let cur = null;
    for (const r of rows) {
      if (!cur) cur = { start: r.start, morceaux: [] };
      cur.morceaux.push(r.text);
      if (r.start - cur.start >= pas) { out.push({ start: cur.start, text: cur.morceaux.join(' ') }); cur = null; }
    }
    if (cur) out.push({ start: cur.start, text: cur.morceaux.join(' ') });
    return out;
  }

  function prompt(tr) {
    const m = tr.meta || {};
    const parts = tranches(tr.rows);
    const withHours = parts.length && parts[parts.length - 1].start >= 3600;
    const entete = [
      m.titre && `Titre : ${m.titre}`,
      m.chaine && `Chaîne : ${m.chaine}`,
      m.duree && `Durée : ${m.duree}`
    ].filter(Boolean).join('\n');

    // Une ligne horodatee par moment : on voit d'un coup d'oeil de quoi parle
    // chaque passage, et on y saute d'un clic. La densite suit la duree — une
    // ligne toutes les ~90 s, entre 8 et 30 lignes.
    const dureeS = Number(m.duree_s) || (tr.rows.length ? tr.rows[tr.rows.length - 1].start : 0);
    const lignes = Math.max(8, Math.min(30, Math.round(dureeS / 90)));
    const pas = Math.max(1, Math.round(dureeS / 60 / lignes));

    // Le format est donne comme un MODELE a recopier, et rappele apres la
    // transcription : un modele suivi d'un rappel est bien mieux respecte
    // qu'une consigne en prose noyee avant un long texte.
    return [
      'Résume cette vidéo YouTube à partir de sa transcription horodatée.',
      '',
      entete,
      '',
      'Réponds EXACTEMENT dans ce format, sans rien avant ni après :',
      '',
      '## En bref',
      '(une phrase sur le sujet de la vidéo)',
      '',
      '## Déroulé',
      '- [0:00] (ce qui se passe, en quelques mots)',
      '- [1:30] (le moment suivant)',
      `(environ ${lignes} lignes, à peu près une toutes les ${pas} minute${pas > 1 ? 's' : ''}, dans l’ordre de la vidéo ; `
        + 'une ligne par moment ou changement de sujet, 12 mots au plus)',
      '',
      '## À retenir',
      '- [m:ss] (une idée clé, avec le timecode où elle est dite)',
      '(2 ou 3 lignes)',
      '',
      'Transcription :',
      parts.map((p) => `[${fmt(p.start, withHours)}] ${p.text}`).join('\n'),
      '',
      'RAPPEL : CHAQUE ligne de « Déroulé » et de « À retenir » commence OBLIGATOIREMENT par un timecode '
        + 'entre crochets, repris de la transcription ci-dessus. Lignes courtes. Reste fidèle à la transcription, '
        + 'n’invente rien. Réponds en français.'
    ].join('\n');
  }

  /* ------------------------------------- timecodes retrouves localement */

  const MOTS_VIDES = new Set(('dans pour avec mais plus tout tous toute toutes cette cela celui celle ceux sont '
    + 'fait faire comme elle elles nous vous leur leurs quand alors donc tres bien aussi encore entre sans sous '
    + 'apres avant depuis etre avoir etait sera peut chose choses video videos avoir quoi juste vraiment ensuite '
    + 'that this with from have they there their about what when which would will just your').split(' '));

  const motsCles = (t) => new Set(
    (String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[a-z0-9]{4,}/g) || [])
      .filter((w) => !MOTS_VIDES.has(w)));

  /**
   * Gemini oublie parfois les timecodes malgre la consigne. Pour chaque point
   * qui n'en a pas, on retrouve le passage de la transcription qui lui
   * ressemble le plus — mots rares en commun, ponderes par leur rarete — et on
   * lui attribue son timecode. Aucune requete : tout se fait ici.
   *
   * Un timecode retrouve ainsi est marque `estimated` et s'affiche
   * differemment : c'est une deduction, pas une affirmation de Gemini.
   */
  function horodater(blocks, rows) {
    if (!rows || !rows.length) return blocks;
    const withHours = rows[rows.length - 1].start >= 3600;
    const segs = rows.map((r) => motsCles(r.text));
    const df = new Map();
    segs.forEach((d) => d.forEach((w) => df.set(w, (df.get(w) || 0) + 1)));
    const idf = (w) => Math.log((segs.length + 1) / ((df.get(w) || 0) + 0.5));
    const FENETRE = 20;              // secondes : un sujet tient rarement en un seul segment

    let precedent = 0;
    return blocks.map((b) => {
      if (b.type !== 'li') return b;
      const deja = b.text.match(A_UN_TS);
      if (deja) { precedent = secondes(deja[0]); return b; }

      const mots = motsCles(b.text);
      if (mots.size < 2) return b;

      // Fenetre glissante sur les SEGMENTS, et non sur les tranches de 20 s du
      // prompt : leurs frontieres coupent les sujets en deux, et le timecode
      // tombait alors sur la mauvaise moitie, quelques secondes trop tard.
      let meilleur = -1;
      let score = 0;
      for (let i = 0; i < rows.length; i++) {
        const communs = new Set();
        for (let j = i; j < rows.length && rows[j].start - rows[i].start <= FENETRE; j++) {
          segs[j].forEach((w) => { if (mots.has(w)) communs.add(w); });
        }
        if (communs.size < 2) continue;
        let s = 0;
        communs.forEach((w) => { s += idf(w); });
        // Les points cles suivent l'ordre de la video : a score voisin, on
        // prefere ce qui vient apres le point precedent.
        if (rows[i].start >= precedent) s += 0.25;
        if (s > score + 1e-9) { score = s; meilleur = i; }
      }
      if (meilleur < 0 || score < 2.5) return b;     // rien de ressemblant : on n'invente pas

      // On se cale sur le premier segment de la fenetre qui parle du sujet.
      let debut = meilleur;
      while (debut < rows.length - 1 && ![...segs[debut]].some((w) => mots.has(w))) debut++;
      const t = rows[debut].start;
      precedent = t;
      return { ...b, text: `[${fmt(t, withHours)}] ${b.text}`, estimated: true };
    });
  }

  /* ------------------------------------------- interface commune (TV.ai) */

  // Etoile de Gemini, en degrade. L'identifiant du degrade doit etre unique.
  let nGradient = 0;
  const etoile = (taille) => {
    const id = `yttools-gm-${++nGradient}`;
    return `<svg viewBox="0 0 24 24" width="${taille}" height="${taille}" aria-hidden="true">`
      + `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">`
      + '<stop offset="0" stop-color="#4285f4"/><stop offset=".55" stop-color="#9b72cb"/>'
      + '<stop offset="1" stop-color="#d96570"/></linearGradient></defs>'
      + `<path fill="url(#${id})" d="M12 2c.6 4.9 2.6 7.9 7.6 9.4.4.1.4.7 0 .8-5 1.6-7 4.6-7.6 9.5-.1.4-.7.4-.8 0-.6-4.9-2.6-7.9-7.6-9.5-.4-.1-.4-.7 0-.8 5-1.5 7-4.5 7.6-9.4.1-.4.7-.4.8 0z"/></svg>`;
  };

  const CROIX = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" '
    + 'd="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7l-1.4-1.4L9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z"/></svg>';

  /** Un texte de Gemini -> des noeuds, ou chaque timecode devient un lien. */
  function avecLiens(texte, estime) {
    const frag = document.createDocumentFragment();
    const fin = duree();
    let pos = 0;
    let premier = null;
    texte.replace(TS_RE, (tout, ts, idx) => {
      const s = secondes(ts);
      if (fin != null && s > fin + 5) return tout;      // une heure, pas un timecode
      if (idx > pos) frag.append(document.createTextNode(texte.slice(pos, idx)));
      const a = document.createElement('a');
      a.className = 'yttools-ai-ts' + (estime && premier === null ? ' is-estimated' : '');
      if (estime && premier === null) a.title = 'Timecode retrouvé dans la transcription';
      a.href = `/watch?v=${encodeURIComponent(videoId())}&t=${s}s`;
      a.dataset.t = String(s);
      a.textContent = ts;
      a.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); aller(s); });
      frag.append(a);
      if (premier === null) premier = s;
      pos = idx + tout.length;
      return tout;
    });
    if (pos < texte.length) frag.append(document.createTextNode(texte.slice(pos)));
    return { frag, premier };
  }

  /** Les blocs de Gemini -> titres, paragraphes et listes, dans `body`. */
  function renderBlocks(body, blocks) {
    let liste = null;
    for (const b of blocks) {
      if (b.type === 'li') {
        if (!liste) { liste = document.createElement('ul'); body.append(liste); }
        const li = document.createElement('li');
        const { frag, premier } = avecLiens(b.text, b.estimated);
        li.append(frag);
        if (premier !== null) li.dataset.t = String(premier);
        liste.append(li);
        continue;
      }
      liste = null;
      if (b.type === 'h') {
        const h = document.createElement('h3');
        h.textContent = b.text.replace(/^#+\s*/, '');
        body.append(h);
      } else {
        const p = document.createElement('p');
        p.append(avecLiens(b.text).frag);
        body.append(p);
      }
    }
  }

  /** Une carte de resume : en-tete (etoile, titre, sous-titre, croix) et corps. */
  function buildCard({ id, titre, label, onClose }) {
    const card = document.createElement('section');
    card.id = id;
    card.className = 'yttools-ai-card';
    card.setAttribute('aria-label', label || titre);

    const head = document.createElement('div');
    head.className = 'yttools-ai-head';
    const icon = document.createElement('span');
    icon.className = 'yttools-ai-icon';
    icon.innerHTML = etoile(20);                       // constante, jamais une donnee
    const textes = document.createElement('div');
    textes.className = 'yttools-ai-titles';
    const t = document.createElement('span');
    t.className = 'yttools-ai-title';
    t.textContent = titre;
    const sous = document.createElement('span');
    sous.className = 'yttools-ai-sub';
    textes.append(t, sous);
    const fermer = document.createElement('button');
    fermer.type = 'button';
    fermer.className = 'yttools-ai-close';
    fermer.title = 'Fermer';
    fermer.setAttribute('aria-label', 'Fermer');
    fermer.innerHTML = CROIX;                          // constante, jamais une donnee
    fermer.addEventListener('click', (e) => { e.preventDefault(); onClose(); });
    head.append(icon, textes, fermer);

    const body = document.createElement('div');
    body.className = 'yttools-ai-body';
    card.append(head, body);
    return card;
  }

  function message(body, texte, onRetry) {
    const box = document.createElement('div');
    box.className = 'yttools-ai-msg';
    const p = document.createElement('p');
    p.textContent = texte;
    box.append(p);
    if (onRetry) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'yttools-ai-retry';
      b.textContent = 'Réessayer';
      b.addEventListener('click', (e) => { e.preventDefault(); onRetry(); });
      box.append(b);
    }
    body.append(box);
  }

  function erreurLisible(err) {
    if (err === 'login') return 'Gemini demande une connexion. Connecte-toi dans la fenêtre qui vient de s’ouvrir, puis réessaie.';
    return err || 'Gemini n’a rien renvoyé.';
  }

  async function ask(texte) {
    try {
      const rep = await chrome.runtime.sendMessage({ type: 'YTTOOLS_SUMMARIZE', prompt: texte });
      if (rep && rep.ok && Array.isArray(rep.blocks) && rep.blocks.length) return rep;
      return { ok: false, error: rep && rep.error };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  TV.ai = { etoile, renderBlocks, buildCard, message, erreurLisible, ask, avecLiens };

  /* ------------------------------------- cote a cote avec la video */

  let focusFor = '';                 // video dont le resume a fait place nette

  const colonne = () =>
    document.querySelector('ytd-watch-flexy #secondary-inner') ||
    document.querySelector('#secondary-inner') ||
    document.querySelector('ytd-watch-flexy #secondary');

  /**
   * Le panneau de vidIQ, tel qu'il est enfant direct de la colonne.
   *
   * On le reconnait a SON propre identifiant ou a sa classe `vidiq-react`
   * (div#video-companion-root sur la vraie page). Surtout pas a la presence de
   * vidIQ a l'interieur : vidIQ pose ses badges dans les cartes suggerees et sa
   * classe `vidiq-scope` sur des conteneurs de YouTube — on cacherait alors les
   * suggestions, voire le panneau de transcription.
   */
  function blocsVidiq(col) {
    const garde = TV.suggestionsBlock(col);
    return Array.from(col.children).filter((n) => {
      if (n === garde || n.id === CARD_ID || n.id === RANK_ID) return false;
      if (n.querySelector('ytd-engagement-panel-section-list-renderer')) return false;
      const cls = typeof n.className === 'string' ? n.className : '';
      return /vidiq|companion/i.test(n.id) || /\bvidiq-react\b/i.test(cls) || /vidiq/i.test(n.tagName);
    });
  }

  function faireDeLaPlace(id) {
    focusFor = id;
    TV.rankHidden.add(id);
    document.getElementById(RANK_ID)?.remove();
    const col = colonne();
    if (col) blocsVidiq(col).forEach((n) => n.setAttribute(HIDDEN, ''));
  }

  function rendreLaPlace() {
    if (focusFor) TV.rankHidden.delete(focusFor);
    focusFor = '';
    document.querySelectorAll('[' + HIDDEN + ']').forEach((n) => n.removeAttribute(HIDDEN));
  }

  // Le masquage ne survit pas a la video : en ouvrir une autre rend tout.
  window.addEventListener('yt-navigate-finish', () => { if (focusFor && focusFor !== videoId()) rendreLaPlace(); });

  /* ------------------------------------------------------------------ bouton */

  function buildButton() {
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.className = 'yttools-ai-btn';
    btn.title = 'Résumer la vidéo avec Gemini';
    btn.setAttribute('aria-label', 'Résumer la vidéo avec Gemini');
    const icon = document.createElement('span');
    icon.className = 'yttools-ai-icon';
    icon.innerHTML = etoile(20);                       // constante, jamais une donnee
    const label = document.createElement('span');
    label.className = 'yttools-ai-label';
    label.textContent = 'Résumer';
    btn.append(icon, label);
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); lancer(); });
    return btn;
  }

  function placeButton() {
    const tr = document.getElementById(TR_BTN_ID);
    if (tr && tr.isConnected) tr.after(buildButton());
  }

  function refreshButton(el) {
    TV.applyTheme(el);
    const charge = !!panneau && panneau.id === videoId() && panneau.status === 'loading';
    const label = el.querySelector('.yttools-ai-label');
    const voulu = charge ? 'Gemini rédige…' : 'Résumer';
    if (label.textContent !== voulu) label.textContent = voulu;
    if (el.dataset.state !== (charge ? 'loading' : 'idle')) el.dataset.state = charge ? 'loading' : 'idle';
    el.disabled = charge;
  }

  /* ----------------------------------------------------------------- panneau */

  function fermer() {
    panneau = null;
    document.getElementById(CARD_ID)?.remove();
    rendreLaPlace();
  }

  function renderBody(el) {
    const cle = panneau ? `${panneau.id}|${panneau.status}` : '';
    if (el.dataset.rendered === cle) return;
    el.dataset.rendered = cle;
    el.dataset.state = panneau ? panneau.status : '';

    const body = el.querySelector('.yttools-ai-body');
    const sous = el.querySelector('.yttools-ai-sub');
    body.textContent = '';
    sous.textContent = '';
    if (!panneau) return;

    if (panneau.status === 'loading') {
      const p = document.createElement('p');
      p.className = 'yttools-ai-wait';
      p.textContent = 'Gemini rédige le résumé… une petite fenêtre s’est ouverte, elle se refermera toute seule.';
      body.append(p);
      return;
    }
    if (panneau.status === 'error') {
      message(body, erreurLisible(panneau.error), () => { cache.delete(videoId()); lancer(true); });
      return;
    }
    sous.textContent = 'par Gemini · clique un timecode pour y aller';
    renderBlocks(body, panneau.blocks);
    surligner();
  }

  /**
   * Le moment en cours de lecture, dans la frise (le premier bloc de lignes
   * horodatees) : celui dont le timecode est le plus avance sans depasser la
   * lecture.
   *
   * Pas « la derniere ligne deja passee dans l'ordre de la page » : « A
   * retenir » vient apres la frise et n'est pas chronologique, le surlignage y
   * aurait saute au lieu de suivre la video.
   */
  function surligner() {
    const card = document.getElementById(CARD_ID);
    const v = video();
    if (!card || !v || card.dataset.state !== 'ok') return;
    const t = v.currentTime;
    const frise = Array.from(card.querySelectorAll('ul')).find((u) => u.querySelector('li[data-t]'));
    let actif = null;
    let plusAvance = -1;
    if (frise) {
      for (const li of frise.querySelectorAll('li[data-t]')) {
        const lt = Number(li.dataset.t);
        if (lt <= t + 0.5 && lt > plusAvance) { plusAvance = lt; actif = li; }
      }
    }
    for (const li of card.querySelectorAll('li.is-active')) if (li !== actif) li.classList.remove('is-active');
    if (actif && !actif.classList.contains('is-active')) actif.classList.add('is-active');
  }

  // timeupdate ne remonte pas, mais un ecouteur en phase de CAPTURE sur le
  // document le recoit quand meme : pas besoin de suivre le <video>.
  document.addEventListener('timeupdate', surligner, true);

  function placeCard() {
    const col = colonne();
    if (!col) return;
    // En tete de colonne : il se lit en meme temps que la video.
    col.prepend(buildCard({ id: CARD_ID, titre: 'Résumé de la vidéo', onClose: fermer }));
  }

  function refreshCard(el) {
    TV.applyTheme(el);
    const col = el.parentElement;
    if (col && col.firstElementChild !== el) TV.moveGently(el, () => col.prepend(el));
    // vidIQ peut remonter son panneau en cours de route : on le recache.
    if (focusFor === videoId() && col) {
      blocsVidiq(col).forEach((n) => { if (!n.hasAttribute(HIDDEN)) n.setAttribute(HIDDEN, ''); });
    }
    renderBody(el);
  }

  /* --------------------------------------------------------------- lancement */

  function rafraichir() {
    const btn = document.getElementById(BTN_ID);
    if (btn) refreshButton(btn);
    let card = document.getElementById(CARD_ID);
    if (panneau && panneau.id === videoId() && !card) {
      placeCard();
      card = document.getElementById(CARD_ID);
    }
    if (card) refreshCard(card);
  }

  async function lancer(forcer = false) {
    const tr = TV.lastTranscript;
    const id = videoId();
    if (!tr || tr.id !== id || !tr.rows || !tr.rows.length) return;

    faireDeLaPlace(id);

    if (!forcer && cache.has(id)) {
      panneau = { id, status: 'ok', blocks: cache.get(id) };
      rafraichir();
      return;
    }
    if (panneau && panneau.id === id && panneau.status === 'loading') return;

    panneau = { id, status: 'loading' };
    rafraichir();

    const rep = await ask(prompt(tr));
    if (!panneau || panneau.id !== id) return;          // video changee ou panneau ferme entre-temps

    if (rep.ok) {
      const blocs = horodater(rep.blocks, tr.rows);
      cache.set(id, blocs);
      panneau = { id, status: 'ok', blocks: blocs };
    } else {
      panneau = { id, status: 'error', error: rep.error };
    }
    rafraichir();
  }

  TV.keepMounted({
    id: BTN_ID,
    wanted: () => {
      const tr = TV.lastTranscript;
      return isWatchPage() && TV.settings.get().transcriptButton && !!tr && tr.id === videoId();
    },
    place: placeButton,
    refresh: refreshButton
  });

  TV.keepMounted({
    id: CARD_ID,
    wanted: () => isWatchPage() && !!panneau && panneau.id === videoId(),
    place: placeCard,
    refresh: refreshCard
  });

  // Exposes pour les tests uniquement.
  window.__yttoolsSummary = { prompt, tranches, horodater, lancer, blocsVidiq };
})();
