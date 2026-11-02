'use strict';

/**
 * YouTube Tools — service worker.
 *
 * Un seul role : faire resumer une video par Gemini. Un script de contenu ne
 * peut ni ouvrir de fenetre ni injecter un script dans un autre site, d'ou ce
 * passage par le service worker.
 *
 * Deroulement, repris de Google More (tools/gemini-rewrite/background-gemini.js) :
 *  1. une PETITE fenetre Gemini s'ouvre au premier plan — dans un onglet en
 *     arriere-plan, Gemini ne redige pas ;
 *  2. gemini-writer.js y est injecte, ecrit le prompt et attend la reponse ;
 *  3. la reponse revient par un port, la fenetre se referme, YouTube reprend
 *     la main et affiche le resume a cote de la video.
 *
 * Aucune cle d'API : c'est la session Gemini de l'utilisateur qui repond, et
 * chaque demande cree une conversation dans son historique Gemini.
 */

const GEMINI_URL = 'https://gemini.google.com/app';
const DELAI_MS = 180000;                 // une video longue peut prendre du temps

async function ouvrirGemini(depuisId) {
  let ref = null;
  try { ref = depuisId != null ? await chrome.windows.get(depuisId) : await chrome.windows.getLastFocused(); }
  catch { ref = null; }

  const width = 520;
  const height = 720;
  const opts = { url: GEMINI_URL, type: 'popup', focused: true, width, height };
  if (ref && typeof ref.left === 'number' && ref.width) {
    opts.left = Math.max(0, ref.left + ref.width - width - 40);
    opts.top = Math.max(0, (ref.top || 0) + 80);
  }
  const win = await chrome.windows.create(opts);
  const tab = (win.tabs && win.tabs[0]) || (await chrome.tabs.query({ windowId: win.id }))[0];
  return { tabId: tab.id, windowId: win.id, retourId: ref ? ref.id : null };
}

async function fermer(job, garderOuverte) {
  if (!garderOuverte) {
    try { await chrome.windows.remove(job.windowId); } catch { /* deja fermee */ }
  }
  if (job.retourId != null) {
    try { await chrome.windows.update(job.retourId, { focused: true }); } catch { /* fenetre fermee */ }
  }
}

async function attendreChargement(tabId, timeout) {
  const fin = Date.now() + timeout;
  while (Date.now() < fin) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'complete') {
      // Sans permission sur l'adresse (page de connexion Google), t.url est absent.
      if (!t.url || !/^https:\/\/gemini\.google\.com\//.test(t.url)) throw new Error('login');
      return;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('Gemini met trop de temps à charger.');
}

/** Injecte le pilote et attend sa reponse par le port qu'il ouvre. */
function dialoguer(job, prompt) {
  return new Promise((resolve, reject) => {
    let fini = false;
    let port = null;

    const conclure = (err, valeur) => {
      if (fini) return;
      fini = true;
      clearTimeout(minuterie);
      chrome.runtime.onConnect.removeListener(surConnexion);
      try { if (port) port.disconnect(); } catch { /* deja ferme */ }
      if (err) reject(err); else resolve(valeur);
    };

    const minuterie = setTimeout(
      () => conclure(new Error('Délai dépassé : Gemini n’a pas répondu à temps.')), DELAI_MS + 15000);

    const surConnexion = (p) => {
      if (p.name !== 'yttools-gemini' || !p.sender || !p.sender.tab || p.sender.tab.id !== job.tabId) return;
      port = p;
      p.onMessage.addListener((m) => {
        if (!m) return;
        if (m.type === 'done') conclure(null, m.blocks);
        else if (m.type === 'error') conclure(new Error(m.error));
      });
      p.onDisconnect.addListener(() => conclure(new Error('La fenêtre Gemini a été fermée.')));
      p.postMessage({ type: 'start', prompt, timeoutMs: DELAI_MS });
    };

    chrome.runtime.onConnect.addListener(surConnexion);
    chrome.scripting.executeScript({ target: { tabId: job.tabId }, files: ['gemini-writer.js'] })
      .catch((e) => conclure(new Error(`Impossible d’agir sur la page Gemini (${(e && e.message) || e}).`)));
  });
}

async function resumer(prompt, depuisId) {
  const job = await ouvrirGemini(depuisId);
  try {
    await attendreChargement(job.tabId, 30000);
    const blocs = await dialoguer(job, prompt);
    await fermer(job, false);
    return { ok: true, blocks: blocs };
  } catch (e) {
    const err = String((e && e.message) || e);
    // Connexion demandee : la fenetre reste ouverte pour que l'utilisateur
    // puisse se connecter. Pour tout autre echec, on la referme.
    await fermer(job, err === 'login');
    return { ok: false, error: err };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.type !== 'YTTOOLS_SUMMARIZE') return false;
  resumer(String(msg.prompt || ''), sender.tab ? sender.tab.windowId : null)
    .then(reply)
    .catch((e) => reply({ ok: false, error: String((e && e.message) || e) }));
  return true;                           // reponse asynchrone
});

/* ------------------------------------------------------------ mise a jour
 * Au demarrage du navigateur et apres chaque (re)chargement de l'extension, on
 * regarde sur GitHub si une version plus recente existe. Si oui, une pastille
 * « MAJ » apparait sur l'icone ; le popup propose alors de l'installer.
 * Une seule petite requete vers raw.githubusercontent.com, sans cookie.
 */
importScripts('update-core.js');

async function pastilleMaj() {
  const res = await self.__yttoolsUpdate.verifier();
  const dispo = !!(res && res.disponible);
  await chrome.action.setBadgeText({ text: dispo ? 'MAJ' : '' });
  if (dispo) await chrome.action.setBadgeBackgroundColor({ color: '#7226ff' });
}

chrome.runtime.onStartup.addListener(() => { pastilleMaj(); });
chrome.runtime.onInstalled.addListener(() => { pastilleMaj(); });
