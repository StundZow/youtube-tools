'use strict';

/**
 * Page de mise a jour, ouverte dans un onglet par le popup.
 * Un onglet, parce que la fenetre de choix de dossier fermerait le popup.
 */
(async () => {
  const U = window.__yttoolsUpdate;
  const $ = (id) => document.getElementById(id);
  const etat = $('etat');
  const notes = $('notes');
  const bouton = $('installer');
  const progres = $('progres');

  const stored = await chrome.storage.local.get('yttools');
  document.documentElement.dataset.theme = (stored.yttools && stored.yttools.theme) || 'light';

  function avance(texte, erreur = false) {
    progres.hidden = false;
    progres.textContent = texte;
    progres.classList.toggle('is-err', erreur);
  }

  $('manuel').addEventListener('click', () => chrome.tabs.create({ url: U.RELEASES_URL }));

  if (!(await U.estDossierLocal())) {
    etat.textContent = 'Cette installation est mise à jour par Chrome lui-même : rien à faire ici.';
    return;
  }

  const info = await U.verifier();
  if (!info) {
    etat.textContent = 'Impossible de joindre GitHub pour le moment. Réessaie plus tard.';
    return;
  }
  if (!info.disponible) {
    etat.textContent = `Tu as déjà la dernière version (${U.installee()}).`;
    return;
  }

  etat.textContent = `Version installée ${U.installee()}, nouvelle version ${info.latest}.`;
  notes.hidden = !info.notes;
  notes.textContent = info.notes;
  bouton.hidden = false;

  bouton.addEventListener('click', async () => {
    bouton.disabled = true;
    try {
      await U.installer(info, avance);
      avance(`Version ${info.latest} installée. Rechargement… Pense à rafraîchir (F5) tes onglets YouTube.`);
      setTimeout(() => chrome.runtime.reload(), 1500);
    } catch (err) {
      const annule = err && (err.name === 'AbortError' || err.name === 'NotAllowedError');
      avance(annule
        ? 'Mise à jour annulée. Relance quand tu veux.'
        : `Échec : ${err.message}. Tu peux télécharger la mise à jour à la main.`, !annule);
      bouton.disabled = false;
    }
  });
})();
