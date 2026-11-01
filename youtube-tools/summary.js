'use strict';

/**
 * YouTube Tools — resume d'une video par Gemini, affiche DANS YouTube.
 *
 * Une fois la transcription copiee (bouton ☰), un bouton « Resumer » apparait
 * a cote. Il envoie la transcription a Gemini (voir background.js) et affiche
 * la reponse dans un panneau en haut de la colonne de droite : on le lit en
 * regardant la video, chaque timecode est cliquable, et le point en cours de
 * lecture est surligne.
 *
 * Le texte de Gemini n'est jamais insere comme HTML : chaque bloc est
 * reconstruit avec textContent, les timecodes devenant des liens.
 */

(() => {
  if (window.__yttoolsSummaryLoaded) return;
  window.__yttoolsSummaryLoaded = true;

  const TV = window.__yttools;
  if (!TV) { console.warn('[YouTube Tools] common.js absent'); return; }

  const BTN_ID = 'yttools-summary-btn';
  const CARD_ID = 'yttools-summary-card';
  const TR_BTN_ID = 'yttools-transcript-btn';

  const videoId = () => new URLSearchParams(location.search).get('v') || '';
  const isWatchPage = () => location.pathname === '/watch' && !!videoId();

  // Resumes deja obtenus, par video : rouvrir le panneau ne redemande rien a
  // Gemini (chaque demande cree une conversation dans son historique).
  const cache = new Map();
  // { id, status: 'loading' | 'ok' | 'error', blocks, error }
  let panneau = null;

  /* -------------------------------------------------------------- timecodes */

  const TS_RE = /\[?\b((?:\d{1,2}:)?\d{1,2}:[0-5]\d)\b\]?/g;
  const secondes = (ts) => ts.split(':').reduce((a, p) => a * 60 + Number(p), 0);

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

  /** Duree de la video en secondes, ou null. Sert a ne pas lier « 12:30 » au-dela de la fin. */
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

  /* ------------------------------------------------------------------ prompt */

  /**
   * Segments regroupes par tranches d'au moins 20 s, un timecode par tranche.
   * Une video d'une heure compte un millier de segments : les taper un par un
   * dans Gemini prendrait du temps pour aucun gain sur le resume.
   */
  function tranches(rows, pas = 20) {
    const withHours = rows[rows.length - 1].start >= 3600;
    const out = [];
    let debut = null;
    let morceaux = [];
    for (const r of rows) {
      if (debut === null) debut = r.start;
      morceaux.push(r.text);
      if (r.start - debut >= pas) {
        out.push(`[${fmt(debut, withHours)}] ${morceaux.join(' ')}`);
        debut = null;
        morceaux = [];
      }
    }
    if (morceaux.length) out.push(`[${fmt(debut, withHours)}] ${morceaux.join(' ')}`);
    return out.join('\n');
  }

  function prompt(tr) {
    const m = tr.meta || {};
    const entete = [
      m.titre && `Titre : ${m.titre}`,
      m.chaine && `Chaîne : ${m.chaine}`,
      m.duree && `Durée : ${m.duree}`
    ].filter(Boolean).join('\n');

    return [
      'Résume cette vidéo YouTube à partir de sa transcription.',
      '',
      entete,
      '',
      'Structure ta réponse en trois parties, avec exactement ces titres :',
      '## En bref',
      'Une ou deux phrases sur le sujet de la vidéo.',
      '## Points clés',
      'Une liste à puces, dans l’ordre de la vidéo. Chaque puce commence par le timecode où le point est abordé, entre crochets, par exemple [3:42].',
      '## À retenir',
      'La conclusion ou le message principal, en une ou deux phrases.',
      '',
      'Reste fidèle à la transcription : n’invente rien qui n’y figure pas. Réponds en français, sans phrase d’introduction ni de conclusion de ta part.',
      '',
      'Transcription :',
      tranches(tr.rows)
    ].join('\n');
  }

  /* ------------------------------------------------------------------- icones */

  // Etoile de Gemini, en degrade. L'identifiant du degrade doit etre unique
  // dans la page : le bouton et le panneau en ont chacun un.
  const etoile = (suffixe, taille) =>
    `<svg viewBox="0 0 24 24" width="${taille}" height="${taille}" aria-hidden="true">` +
    `<defs><linearGradient id="yttools-gm-${suffixe}" x1="0" y1="0" x2="1" y2="1">` +
    '<stop offset="0" stop-color="#4285f4"/><stop offset=".55" stop-color="#9b72cb"/>' +
    '<stop offset="1" stop-color="#d96570"/></linearGradient></defs>' +
    `<path fill="url(#yttools-gm-${suffixe})" d="M12 2c.6 4.9 2.6 7.9 7.6 9.4.4.1.4.7 0 .8-5 1.6-7 4.6-7.6 9.5-.1.4-.7.4-.8 0-.6-4.9-2.6-7.9-7.6-9.5-.4-.1-.4-.7 0-.8 5-1.5 7-4.5 7.6-9.4.1-.4.7-.4.8 0z"/></svg>`;

  const CROIX =
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" ' +
    'd="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7l-1.4-1.4L9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z"/></svg>';

  /* ------------------------------------------------------------------ bouton */

  function buildButton() {
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.title = 'Résumer la vidéo avec Gemini';
    btn.setAttribute('aria-label', 'Résumer la vidéo avec Gemini');
    const icon = document.createElement('span');
    icon.className = 'yttools-sm-icon';
    icon.innerHTML = etoile('btn', 20);                 // constante, jamais une donnee
    const label = document.createElement('span');
    label.className = 'yttools-sm-label';
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
    const label = el.querySelector('.yttools-sm-label');
    const voulu = charge ? 'Gemini rédige…' : 'Résumer';
    if (label.textContent !== voulu) label.textContent = voulu;
    if (el.dataset.state !== (charge ? 'loading' : 'idle')) el.dataset.state = charge ? 'loading' : 'idle';
    el.disabled = charge;
  }

  /* ----------------------------------------------------------------- panneau */

  /** Un texte de Gemini -> des noeuds, ou chaque timecode devient un lien. */
  function avecLiens(texte) {
    const frag = document.createDocumentFragment();
    const fin = duree();
    let pos = 0;
    let premier = null;
    texte.replace(TS_RE, (tout, ts, idx) => {
      const s = secondes(ts);
      if (fin != null && s > fin + 5) return tout;      // une heure, pas un timecode
      if (idx > pos) frag.append(document.createTextNode(texte.slice(pos, idx)));
      const a = document.createElement('a');
      a.className = 'yttools-sm-ts';
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

  function buildCard() {
    const card = document.createElement('section');
    card.id = CARD_ID;
    card.setAttribute('aria-label', 'Résumé de la vidéo');

    const head = document.createElement('div');
    head.className = 'yttools-sm-head';
    const icon = document.createElement('span');
    icon.className = 'yttools-sm-icon';
    icon.innerHTML = etoile('card', 20);                // constante, jamais une donnee
    const titre = document.createElement('span');
    titre.className = 'yttools-sm-title';
    titre.textContent = 'Résumé';
    const fermer = document.createElement('button');
    fermer.type = 'button';
    fermer.className = 'yttools-sm-close';
    fermer.title = 'Fermer le résumé';
    fermer.setAttribute('aria-label', 'Fermer le résumé');
    fermer.innerHTML = CROIX;                           // constante, jamais une donnee
    fermer.addEventListener('click', (e) => {
      e.preventDefault();
      panneau = null;
      document.getElementById(CARD_ID)?.remove();
    });
    head.append(icon, titre, fermer);

    const body = document.createElement('div');
    body.className = 'yttools-sm-body';
    card.append(head, body);
    return card;
  }

  function message(texte, avecReessai) {
    const box = document.createElement('div');
    box.className = 'yttools-sm-msg';
    const p = document.createElement('p');
    p.textContent = texte;
    box.append(p);
    if (avecReessai) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'yttools-sm-retry';
      b.textContent = 'Réessayer';
      b.addEventListener('click', (e) => { e.preventDefault(); cache.delete(videoId()); lancer(true); });
      box.append(b);
    }
    return box;
  }

  function erreurLisible(err) {
    if (err === 'login') return 'Gemini demande une connexion. Connecte-toi dans la fenêtre qui vient de s’ouvrir, puis réessaie.';
    return err || 'Gemini n’a rien renvoyé.';
  }

  function renderBody(el) {
    const cle = panneau ? `${panneau.id}|${panneau.status}` : '';
    if (el.dataset.rendered === cle) return;
    el.dataset.rendered = cle;

    const body = el.querySelector('.yttools-sm-body');
    body.textContent = '';
    el.dataset.state = panneau ? panneau.status : '';

    if (!panneau) return;
    if (panneau.status === 'loading') {
      const p = document.createElement('p');
      p.className = 'yttools-sm-wait';
      p.textContent = 'Gemini rédige le résumé… une petite fenêtre s’est ouverte, elle se refermera toute seule.';
      body.append(p);
      return;
    }
    if (panneau.status === 'error') {
      body.append(message(erreurLisible(panneau.error), true));
      return;
    }

    let liste = null;
    for (const b of panneau.blocks) {
      if (b.type === 'li') {
        if (!liste) { liste = document.createElement('ul'); body.append(liste); }
        const li = document.createElement('li');
        const { frag, premier } = avecLiens(b.text);
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
    surligner();
  }

  /**
   * Le point en cours de lecture : le dernier dont le timecode est deja passe.
   * C'est ce qui permet de suivre le resume en meme temps que la video.
   */
  function surligner() {
    const card = document.getElementById(CARD_ID);
    const v = video();
    if (!card || !v || card.dataset.state !== 'ok') return;
    const t = v.currentTime;
    let actif = null;
    for (const li of card.querySelectorAll('li[data-t]')) {
      if (Number(li.dataset.t) <= t + 0.5) actif = li;
    }
    for (const li of card.querySelectorAll('li.is-active')) if (li !== actif) li.classList.remove('is-active');
    if (actif && !actif.classList.contains('is-active')) actif.classList.add('is-active');
  }

  // timeupdate ne remonte pas, mais un ecouteur en phase de CAPTURE sur le
  // document le recoit quand meme : pas besoin de suivre le <video>, que
  // YouTube peut remplacer.
  document.addEventListener('timeupdate', surligner, true);

  function placeCard() {
    const col = document.querySelector('ytd-watch-flexy #secondary-inner') ||
                document.querySelector('#secondary-inner') ||
                document.querySelector('ytd-watch-flexy #secondary');
    if (!col) return;
    // En tete de colonne : il doit se lire en meme temps que la video, sans
    // avoir a faire defiler la page.
    col.prepend(buildCard());
  }

  function refreshCard(el) {
    TV.applyTheme(el);
    const col = el.parentElement;
    if (col && col.firstElementChild !== el) col.prepend(el);   // YouTube a reordonne la colonne
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

    if (!forcer && cache.has(id)) {
      panneau = { id, status: 'ok', blocks: cache.get(id) };
      rafraichir();
      return;
    }
    if (panneau && panneau.id === id && panneau.status === 'loading') return;

    panneau = { id, status: 'loading' };
    rafraichir();

    let rep;
    try {
      rep = await chrome.runtime.sendMessage({ type: 'YTTOOLS_SUMMARIZE', prompt: prompt(tr) });
    } catch (e) {
      rep = { ok: false, error: String((e && e.message) || e) };
    }
    if (!panneau || panneau.id !== id) return;          // video changee ou panneau ferme entre-temps

    if (rep && rep.ok && Array.isArray(rep.blocks) && rep.blocks.length) {
      cache.set(id, rep.blocks);
      panneau = { id, status: 'ok', blocks: rep.blocks };
    } else {
      panneau = { id, status: 'error', error: rep && rep.error };
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
  window.__yttoolsSummary = { prompt, tranches, avecLiens, lancer };
})();
