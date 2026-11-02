'use strict';

/**
 * Capture d'ecran de la video : un bouton appareil photo dans la barre du
 * lecteur, a gauche des sous-titres.
 *
 * L'image est prise a la resolution REELLE de la video (pas la taille de la
 * fenetre), copiee dans le presse-papiers, et enregistree en .png si le
 * reglage « Enregistrer un fichier » est actif — ou si la copie echoue.
 *
 * YouTube lit la video depuis un blob local (Media Source) : le canvas n'est
 * pas « teinte », l'image peut donc en sortir. Aucune requete.
 */
(function () {
  if (window.__yttoolsCapture) return;
  const TV = window.__yttools;
  if (!TV) return;

  const BTN_ID = 'yttools-capture-btn';
  const TOAST_ID = 'yttools-capture-toast';

  const ICONE = '<svg fill="none" height="24" viewBox="0 0 24 24" width="24" aria-hidden="true">'
    + '<path d="M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z" '
    + 'stroke="white" stroke-width="2" stroke-linejoin="round"/>'
    + '<circle cx="12" cy="13" r="3.5" stroke="white" stroke-width="2"/></svg>';

  const surLecture = () => location.pathname === '/watch';
  const lecteur = () => document.querySelector('#movie_player');
  const video = () => document.querySelector('#movie_player video.html5-main-video, #movie_player video');

  /* ------------------------------------------------------------- l'image */

  /** « 1:02:03 » ou « 4:05 » -> morceau de nom de fichier « 1h02m03s » / « 4m05s ». */
  function horodatage(s) {
    const t = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const sec = t % 60;
    const p2 = (n) => String(n).padStart(2, '0');
    return (h ? h + 'h' + p2(m) : String(m)) + 'm' + p2(sec) + 's';
  }

  function titre() {
    const h1 = document.querySelector('ytd-watch-metadata h1, #title h1');
    return (h1 && h1.textContent.trim()) || document.title.replace(/\s*-\s*YouTube\s*$/, '');
  }

  /** L'image courante de la video, en PNG, a sa resolution d'origine. */
  function image(v) {
    return new Promise((ok, ko) => {
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      c.toBlob((b) => (b ? ok(b) : ko(new Error('image vide'))), 'image/png');
    });
  }

  async function copierImage(blob) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return true;
    } catch {
      return false;
    }
  }

  /* ------------------------------------------------------------ retour */

  function annonce(texte) {
    const p = lecteur();
    if (!p) return;
    let t = document.getElementById(TOAST_ID);
    if (!t) {
      t = document.createElement('div');
      t.id = TOAST_ID;
      t.setAttribute('role', 'status');
    }
    if (t.parentElement !== p) p.append(t);
    t.textContent = texte;
    t.classList.remove('is-on');
    void t.offsetWidth;                      // relance l'animation
    t.classList.add('is-on');
    clearTimeout(annonce.minuteur);
    annonce.minuteur = setTimeout(() => t.classList.remove('is-on'), 2200);
  }

  function flash() {
    const p = lecteur();
    if (!p) return;
    const f = document.createElement('div');
    f.className = 'yttools-capture-flash';
    p.append(f);
    setTimeout(() => f.remove(), 450);
  }

  /* ------------------------------------------------------------- action */

  async function capturer() {
    const v = video();
    if (!v || !v.videoWidth || v.readyState < 2) {
      annonce('Vidéo pas encore chargée');
      return;
    }
    let blob;
    try {
      blob = await image(v);
    } catch {
      // Video protegee (location, film) : le navigateur refuse d'en sortir l'image.
      annonce('Capture impossible sur cette vidéo');
      return;
    }
    flash();
    const nom = `${TV.slug(titre(), 'video')}_${horodatage(v.currentTime)}.png`;
    const copie = await copierImage(blob);
    const fichier = (TV.settings.get().saveAsFile || !copie) ? TV.downloadBlob(blob, nom) : false;
    annonce(copie && fichier ? 'Capture copiée et enregistrée'
      : copie ? 'Capture copiée'
      : fichier ? 'Capture enregistrée'
      : 'Capture impossible');
  }

  /* -------------------------------------------------------------- bouton */

  function bouton() {
    const b = document.createElement('button');
    b.id = BTN_ID;
    b.type = 'button';
    b.className = 'ytp-button yttools-capture-btn';
    b.title = 'Capture d’écran (copiée dans le presse-papiers)';
    b.setAttribute('aria-label', 'Capture d’écran de la vidéo');
    b.innerHTML = ICONE;                     // constante, jamais une donnee
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); capturer(); });
    return b;
  }

  function placer() {
    // La barre de controles n'est pas toujours DANS #movie_player : sur la page
    // relevee, elle en est la voisine, sous #ytd-player. On cherche dans les deux.
    const dans = (sel) => document.querySelector(`#ytd-player ${sel}, #movie_player ${sel}`);
    const zone = dans('.ytp-right-controls-left') || dans('.ytp-right-controls');
    if (!zone) return;
    const avant = zone.querySelector('.ytp-subtitles-button, .ytp-settings-button');
    if (avant && avant.parentElement === zone) avant.before(bouton());
    else zone.prepend(bouton());
  }

  TV.keepMounted({
    id: BTN_ID,
    wanted: () => surLecture() && TV.settings.get().captureButton !== false && !!lecteur(),
    place: placer
  });

  window.__yttoolsCapture = { capturer, horodatage, image };
})();
