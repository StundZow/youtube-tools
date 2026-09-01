'use strict';

/**
 * PrevYou — injection de l'apercu dans le feed YouTube.
 *
 * Principe : plutot que d'injecter du HTML fige (qui casse a chaque refonte de
 * YouTube), on clone une vraie carte video deja presente sur la page et on
 * remplace uniquement son contenu : miniature, titre, chaine, avatar, duree.
 * Le rendu est donc toujours celui du layout courant.
 */

(() => {
  if (window.__prevyouLoaded) return;
  window.__prevyouLoaded = true;

  const MARK = 'data-prevyou';
  const MAX_RANDOM = 12;

  // L'apercu est volontairement ephemere : il n'existe qu'apres un clic sur le
  // bouton du popup, uniquement sur la page ou on a clique, et il disparait des
  // qu'on navigue ou qu'on recharge. Rien n'est repris automatiquement.
  let data = null;
  let active = false;
  let activeUrl = '';
  let slot = null;          // index choisi, stable tant que l'apercu vit
  let observer = null;
  let pending = null;
  let lastCheck = 0;

  /* ------------------------------------------------------ selection du modele */

  // Du plus specifique au plus generique : accueil/abonnements, recherche,
  // nouveaux « lockups », colonne de droite du lecteur, ancienne grille.
  const ITEM_TAGS = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'yt-lockup-view-model',
    'ytd-compact-video-renderer',
    'ytd-grid-video-renderer'
  ];

  const EXCLUDE = [
    'ytm-shorts-lockup-view-model',
    '.shortsLockupViewModelHost',
    'ytd-reel-item-renderer',
    'ytd-rich-shelf-renderer',
    'ytd-ad-slot-renderer',
    'ytd-display-ad-renderer',
    'ytd-promoted-video-renderer'
  ].join(',');

  function isUsable(node) {
    if (node.hasAttribute(MARK)) return false;
    if (node.closest('[' + MARK + ']')) return false;
    if (node.querySelector(EXCLUDE)) return false;
    if (!node.querySelector('img')) return false;
    const r = node.getBoundingClientRect();
    return r.width > 140 && r.height > 80;
  }

  /**
   * Renvoie la plus grosse famille de cartes video de la page : le groupe de
   * noeuds de meme tag partageant un parent. Sur l'accueil, YouTube repartit
   * parfois les cartes en lignes (ytd-rich-grid-row) : on recolle alors toutes
   * les lignes pour que la position aleatoire couvre bien la grille entiere.
   */
  function findGrid() {
    for (const tag of ITEM_TAGS) {
      const all = [...document.querySelectorAll(tag)].filter(isUsable);
      if (all.length < 2) continue;

      const groups = new Map();
      for (const node of all) {
        const parent = node.parentElement;
        if (!parent) continue;
        if (!groups.has(parent)) groups.set(parent, []);
        groups.get(parent).push(node);
      }

      let best = null;
      for (const [container, siblings] of groups) {
        if (!best || siblings.length > best.siblings.length) best = { container, siblings };
      }
      if (!best || best.siblings.length < 2) continue;

      const row = best.container.closest('ytd-rich-grid-row');
      if (row && row.parentElement) {
        const across = [...row.parentElement.querySelectorAll(tag)].filter(isUsable);
        if (across.length > best.siblings.length) best.siblings = across;
      }
      return best.siblings;
    }
    return null;
  }

  /* ---------------------------------------------------------------- images */

  /** Decode un dataURL sans passer par le reseau (immunise contre la CSP). */
  async function toBitmap(dataUrl) {
    const comma = dataUrl.indexOf(',');
    const mime = dataUrl.slice(5, comma).split(';')[0] || 'image/png';
    const bin = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return createImageBitmap(new Blob([bytes], { type: mime }));
  }

  /** Repli : si la CSP de YouTube bloquait les data:, on peint dans un canvas. */
  async function paintCanvas(img, dataUrl) {
    if (!img.isConnected) return;
    try {
      const bmp = await toBitmap(dataUrl);
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      canvas.getContext('2d').drawImage(bmp, 0, 0);
      canvas.className = img.className + ' prevyou-canvas';
      canvas.setAttribute('style', img.getAttribute('style') || '');
      img.replaceWith(canvas);
    } catch { /* on garde la miniature d'origine */ }
  }

  function paint(img, dataUrl, cls) {
    if (img.dataset.prevyouSrc === dataUrl) return;
    img.dataset.prevyouSrc = dataUrl;
    img.classList.add(cls);
    img.removeAttribute('srcset');
    img.removeAttribute('data-src');
    img.removeAttribute('loading');
    img.addEventListener('error', () => paintCanvas(img, dataUrl), { once: true });
    img.src = dataUrl;
    // Un blocage CSP ne declenche pas toujours « error » de facon fiable.
    setTimeout(() => {
      if (img.isConnected && img.naturalWidth === 0) paintCanvas(img, dataUrl);
    }, 600);
  }

  /* ----------------------------------------------------------------- texte */

  // YouTube a migre ses classes en camelCase (ytLockupMetadataViewModelTitle...)
  // mais les anciennes subsistent selon les pages : on garde les deux jeux.
  const TITLE_SEL = [
    '#video-title',
    'a#video-title-link',
    '.ytLockupMetadataViewModelTitle',
    '.yt-lockup-metadata-view-model__title',
    '.yt-lockup-metadata-view-model-wiz__title',
    'h3 a[title]'
  ].join(',');

  const CHANNEL_SEL = [
    'ytd-channel-name #text',
    'ytd-channel-name a',
    '#channel-name #text'
  ].join(',');

  const META_ROW_SEL = [
    '.ytContentMetadataViewModelMetadataRow',
    '.yt-content-metadata-view-model__metadata-row',
    '.yt-content-metadata-view-model-wiz__metadata-row'
  ].join(',');

  const META_TEXT_SEL = [
    '.ytContentMetadataViewModelMetadataText',
    '.yt-content-metadata-view-model__metadata-text'
  ].join(',');

  const DURATION_SEL = [
    'ytd-thumbnail-overlay-time-status-renderer #text',
    '.ytBadgeShapeText',
    '.badge-shape-wiz__text',
    '.thumbnail-overlay-badge-shape span'
  ].join(',');

  const LEAF_SEL =
    '.ytAttributedStringHost, .yt-core-attributed-string, yt-formatted-string, span, a';

  /**
   * Ecrit le texte dans le noeud feuille qui porte deja le plus de texte : on
   * preserve ainsi les spans stylises de YouTube et on evite d'ecrire dans une
   * icone ou un badge vide.
   */
  function setText(node, text) {
    if (!node || !text) return;

    let target = node;
    let best = 0;
    for (const cand of node.querySelectorAll(LEAF_SEL)) {
      if (cand.querySelector(LEAF_SEL)) continue;      // pas une feuille
      const len = cand.textContent.trim().length;
      if (len > best) { best = len; target = cand; }
    }
    target.textContent = text;

    if (node.hasAttribute('title')) node.title = text;
    if (node.hasAttribute('aria-label')) node.setAttribute('aria-label', text);
    const link = node.closest('a');
    if (link && link.hasAttribute('title')) link.title = text;
  }

  function statsParts() {
    const fr = (document.documentElement.lang || navigator.language || '').startsWith('fr');
    return fr ? ['12 k vues', 'il y a 2 heures'] : ['12K views', '2 hours ago'];
  }

  /**
   * Une ligne de metadonnees est decoupee en fragments (« 220 k » | « il y a
   * 1 an ») separes par des delimiteurs : on remplace fragment par fragment et
   * on supprime ceux qui restent, sinon des donnees de la video clonee
   * subsistent a l'ecran.
   */
  function setMetaRow(row, parts) {
    const texts = [...row.querySelectorAll(META_TEXT_SEL)];
    if (!texts.length) { setText(row, parts.join(' · ')); return; }

    texts.forEach((node, i) => {
      if (i < parts.length) {
        node.textContent = parts[i];
      } else {
        const prev = node.previousElementSibling;
        if (prev && /elimiter/.test(prev.className || '')) prev.remove();
        node.remove();
      }
    });

    if (texts.length < parts.length) {
      texts[texts.length - 1].textContent = parts.slice(texts.length - 1).join(' · ');
    }
  }

  /* ---------------------------------------------------------------- avatar */

  const AVATAR_HOSTS = [
    '#avatar', '#avatar-link', 'yt-img-shadow#avatar', 'yt-avatar-shape',
    'yt-decorated-avatar-view-model', '.yt-spec-avatar-shape', 'ytd-channel-name',
    '#channel-thumbnail'
  ].join(',');

  /**
   * Repere les images d'avatar par leur *index*, sur le modele d'origine (le
   * clone n'est pas encore dans le document, donc sans dimensions mesurables).
   */
  function avatarIndices(model) {
    const imgs = [...model.querySelectorAll('img')];
    const set = new Set();
    const mark = (img) => { const i = imgs.indexOf(img); if (i >= 0) set.add(i); };

    model.querySelectorAll(AVATAR_HOSTS).forEach((h) => h.querySelectorAll('img').forEach(mark));
    model.querySelectorAll('img.ytSpecAvatarShapeImage, img.yt-spec-avatar-shape__image').forEach(mark);

    // Repli : une petite image quasi carree est un avatar.
    imgs.forEach((img, i) => {
      const r = img.getBoundingClientRect();
      if (r.width && r.width <= 64 && Math.abs(r.width - r.height) <= 6) set.add(i);
    });
    return set;
  }

  /* --------------------------------------------------------------- montage */

  function neutralize(clone) {
    // Ce qui trahirait la video d'origine ou rejouerait un apercu au survol.
    clone.querySelectorAll(
      '#mouseover-overlay, ytd-video-preview, #dismissed, ' +
      'ytd-thumbnail-overlay-resume-playback-renderer, ' +
      'ytd-thumbnail-overlay-now-playing-renderer, ' +
      'ytd-thumbnail-overlay-inline-unplayable-renderer, ' +
      'ytd-badge-supported-renderer, ' +
      '.ytThumbnailOverlayProgressBarHost, yt-thumbnail-overlay-progress-bar-view-model'
    ).forEach((n) => n.remove());

    clone.querySelectorAll('a[href]').forEach((a) => {
      a.removeAttribute('href');
      a.removeAttribute('ping');
    });

    // On coupe tout ce qui pourrait lancer la lecture ou la navigation.
    ['click', 'auxclick', 'mousedown', 'mouseover', 'mouseenter', 'pointerover', 'pointerenter']
      .forEach((type) => {
        clone.addEventListener(type, (e) => {
          e.stopPropagation();
          if (type === 'click' || type === 'auxclick' || type === 'mousedown') e.preventDefault();
        }, true);
      });
  }

  function fill(clone, avatars) {
    const imgs = [...clone.querySelectorAll('img')];
    imgs.forEach((img, i) => {
      if (avatars.has(i)) {
        if (data.avatar) paint(img, data.avatar, 'prevyou-avatar');
      } else if (data.thumb) {
        paint(img, data.thumb, 'prevyou-thumb');
      }
    });

    // Miniatures posees en background-image (rare, mais ca existe).
    if (data.thumb) {
      clone.querySelectorAll('[style*="background-image"]').forEach((n) => {
        n.style.backgroundImage = 'url("' + data.thumb + '")';
        n.style.backgroundSize = 'cover';
      });
    }

    if (data.title) clone.querySelectorAll(TITLE_SEL).forEach((n) => setText(n, data.title));

    let channelDone = false;
    if (data.channel) {
      clone.querySelectorAll(CHANNEL_SEL).forEach((n) => { setText(n, data.channel); channelDone = true; });
    }

    // Lignes de metadonnees : la premiere porte la chaine, la derniere les vues
    // et la date de la video clonee — on remplace les deux.
    const rows = [...clone.querySelectorAll(META_ROW_SEL)];
    const stats = statsParts();
    if (rows.length > 1) {
      if (data.channel && !channelDone) setMetaRow(rows[0], [data.channel]);
      setMetaRow(rows[rows.length - 1], stats);
    } else if (rows.length === 1) {
      setMetaRow(rows[0], stats);
    }

    const metaLine = clone.querySelector('#metadata-line');
    if (metaLine) {
      const spans = metaLine.querySelectorAll('span');
      if (spans[0]) spans[0].textContent = stats[0];
      if (spans[1]) spans[1].textContent = stats[1];
    }

    // Duree : uniquement les badges qui ressemblent a un timecode (les autres
    // disent « 4K », « NOUVEAU », « EN DIRECT »...).
    clone.querySelectorAll(DURATION_SEL).forEach((badge) => {
      if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(badge.textContent.trim())) badge.textContent = '12:34';
    });
  }

  /* ------------------------------------------------------------- injection */

  function inject() {
    if (!active || !data) return false;
    if (document.querySelector('[' + MARK + ']')) return true;

    const siblings = findGrid();
    if (!siblings) return false;

    const model = siblings[0];
    const avatars = avatarIndices(model);

    const clone = model.cloneNode(true);
    clone.setAttribute(MARK, '');
    clone.classList.add('prevyou-item');
    clone.removeAttribute('id');

    neutralize(clone);
    fill(clone, avatars);

    if (slot === null) {
      slot = data.random ? Math.floor(Math.random() * Math.min(siblings.length, MAX_RANDOM)) : 0;
    }
    const ref = siblings[Math.min(slot, siblings.length - 1)];
    ref.parentElement.insertBefore(clone, ref);

    // Filet de securite : si le composant se re-rend en s'attachant, on repose
    // notre contenu (et les avatars sont enfin mesurables).
    requestAnimationFrame(() => { if (clone.isConnected) fill(clone, avatars); });
    setTimeout(() => { if (clone.isConnected) fill(clone, avatars); }, 700);

    return true;
  }

  function remove() {
    document.querySelectorAll('[' + MARK + ']').forEach((n) => n.remove());
  }

  function schedule(delay = 300) {
    clearTimeout(pending);
    pending = setTimeout(inject, delay);
  }

  /* ----------------------------------------------------------- cycle de vie */

  /** Coupe tout : plus d'apercu, plus de surveillance, jusqu'au prochain clic. */
  function deactivate() {
    active = false;
    data = null;
    slot = null;
    if (observer) { observer.disconnect(); observer = null; }
    clearTimeout(pending);
    remove();
  }

  /**
   * Surveillance limitee a la page courante : elle sert seulement a reposer la
   * carte si YouTube re-rend sa grille (scroll, redimensionnement). Des que
   * l'URL change, on desactive.
   */
  function watch() {
    if (observer) return;
    observer = new MutationObserver(() => {
      if (!active) return;

      if (location.href !== activeUrl) { deactivate(); return; }

      // YouTube mute enormement (lecteur, compteurs...) : on limite les tests.
      const now = Date.now();
      if (now - lastCheck < 700) return;
      lastCheck = now;
      if (document.querySelector('[' + MARK + ']')) return;
      schedule(250);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Navigation interne de YouTube : l'apercu ne suit jamais sur la page suivante.
  window.addEventListener('yt-navigate-start', () => { if (active) deactivate(); });
  window.addEventListener('yt-navigate-finish', () => {
    if (active && location.href !== activeUrl) deactivate();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg.type === 'PREVYOU_APPLY') {
      remove();
      data = msg.data;
      active = true;
      activeUrl = location.href;
      slot = null;
      watch();
      const ok = inject();
      if (!ok) schedule(900);
      respond({ ok });
      return true;
    }
    if (msg.type === 'PREVYOU_REMOVE') {
      deactivate();
      respond({ ok: true });
      return true;
    }
    if (msg.type === 'PREVYOU_PING') {
      respond({ ok: true, injected: !!document.querySelector('[' + MARK + ']') });
      return true;
    }
    return false;
  });

  // Volontairement : aucune lecture de chrome.storage au chargement, aucun
  // listener sur storage.onChanged. Sans clic sur « Aperçu », l'extension ne
  // touche a rien.
})();
