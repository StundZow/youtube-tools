'use strict';

/**
 * YouTube Tools — classement sur 10 : pont avec la page.
 *
 * Tourne dans le monde de la PAGE (world: "MAIN" dans le manifest), seul
 * endroit ou les donnees de la video sont lisibles : YouTube les range dans des
 * proprietes JavaScript de ytd-watch-flexy, invisibles depuis le monde isole
 * ou vivent les autres scripts de l'extension.
 *
 * Ce script ne fait QUE recopier quelques informations publiques dans un
 * attribut du document, ou rank.js vient les lire :
 *   id, chaine, titre, vues, date de publication, direct ou non, Short ou non,
 *   ainsi que la cle et la version d'API que la page utilise deja.
 * Il n'emet aucune requete, ne lit aucun cookie et ne touche a rien d'autre.
 */

(() => {
  if (window.__yttoolsRankBridge) return;
  window.__yttoolsRankBridge = true;

  const ATTR = 'data-yttools-rank-src';

  function publish() {
    if (location.pathname !== '/watch') return;
    const flexy = document.querySelector('ytd-watch-flexy');
    const player = document.querySelector('#movie_player');
    const pr = (flexy && flexy.playerData) ||
               (player && typeof player.getPlayerResponse === 'function' && player.getPlayerResponse());
    const d = pr && pr.videoDetails;
    if (!d || !d.videoId) return;

    const mf = (pr.microformat && pr.microformat.playerMicroformatRenderer) || {};
    const cfg = window.ytcfg;
    const get = (k) => (cfg && typeof cfg.get === 'function' ? cfg.get(k) : '') || '';

    const data = JSON.stringify({
      id: d.videoId,
      channel: d.channelId || '',
      title: d.title || '',
      views: Number(d.viewCount) || 0,
      published: (mf.liveBroadcastDetails && mf.liveBroadcastDetails.startTimestamp) || mf.publishDate || '',
      live: d.isLive === true || d.isUpcoming === true,
      short: mf.isShortsEligible === true,
      key: get('INNERTUBE_API_KEY'),
      version: get('INNERTUBE_CLIENT_VERSION')
    });

    const root = document.documentElement;
    if (root.getAttribute(ATTR) !== data) root.setAttribute(ATTR, data);
  }

  // YouTube est une application a page unique : la navigation ne recharge pas
  // le script. Les evenements couvrent le cas courant, l'intervalle rattrape
  // les donnees qui arrivent apres l'evenement.
  window.addEventListener('yt-navigate-finish', publish);
  window.addEventListener('yt-page-data-updated', publish);
  setInterval(publish, 1000);
  publish();
})();
