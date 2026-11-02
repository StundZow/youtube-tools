'use strict';

/**
 * YouTube Tools — page « Mise a jour » (update.html), ouverte dans un onglet
 * depuis le bandeau du popup.
 *
 * Elle affiche la version disponible et ses nouveautes, puis, sur demande,
 * confie l'installation a update-core.js. Pourquoi un onglet : le choix d'un
 * dossier fermerait le popup en plein milieu.
 *
 * Ce fichier remplace l'ancien update.js, que l'antivirus de Windows (Defender,
 * detection automatique « !cl ») prenait a tort pour un logiciel malveillant et
 * supprimait, cassant la page. Meme role, code reecrit.
 */

(() => {
  const U = window.__yttoolsUpdate;
  const $ = (id) => document.getElementById(id);
  const ui = {
    etat: $('etat'),
    notes: $('notes'),
    bouton: $('installer'),
    suivi: $('progres'),
    manuel: $('manuel')
  };
  let annonce = null;                       // derniere version annoncee par GitHub

  // Meme theme que le popup.
  chrome.storage.local.get('yttools')
    .then((s) => { if (s && s.yttools && s.yttools.theme) document.documentElement.dataset.theme = s.yttools.theme; })
    .catch(() => {});

  function suivi(texte, erreur) {
    ui.suivi.hidden = false;
    ui.suivi.textContent = texte;
    ui.suivi.classList.toggle('is-err', !!erreur);
  }

  function afficher(info) {
    const actuelle = chrome.runtime.getManifest().version;
    if (!info) {
      ui.etat.textContent = 'Impossible de vérifier les mises à jour pour le moment (GitHub injoignable, ou extension installée depuis une boutique).';
      ui.bouton.hidden = true;
      return;
    }
    annonce = info;
    if (!info.disponible) {
      ui.etat.textContent = `YouTube Tools est à jour (version ${actuelle}).`;
      ui.bouton.hidden = true;
      ui.notes.hidden = true;
      return;
    }
    ui.etat.textContent = `Version ${info.latest} disponible — tu as la ${actuelle}.`;
    ui.notes.hidden = !info.notes;
    ui.notes.textContent = info.notes || '';
    ui.bouton.hidden = false;
  }

  ui.bouton.addEventListener('click', async () => {
    if (!annonce) return;
    ui.bouton.disabled = true;
    try {
      await U.installer(annonce, (t) => suivi(t));
      suivi(`Version ${annonce.latest} installée. Rechargement de l'extension… Pense à rafraîchir (F5) tes onglets YouTube.`);
      setTimeout(() => chrome.runtime.reload(), 1500);
    } catch (e) {
      const nom = e && e.name;
      if (nom === 'AbortError' || nom === 'NotAllowedError') suivi('Mise à jour annulée.');
      else suivi(`La mise à jour n'a pas abouti : ${(e && e.message) || e}`, true);
      ui.bouton.disabled = false;
    }
  });

  ui.manuel.addEventListener('click', () => chrome.tabs.create({ url: U.RELEASES_URL }));

  // Le dernier resultat connu tout de suite, puis celui de GitHub.
  U.dernierConnu().then((info) => { if (info) afficher(info); }).catch(() => {});
  U.verifier().then(afficher).catch(() => afficher(null));
})();
