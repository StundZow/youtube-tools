'use strict';

/**
 * YouTube Tools — pilote de Gemini pour le resume d'une video.
 *
 * Injecte par background.js dans une petite fenetre gemini.google.com. Ecrit le
 * prompt, l'envoie, attend la fin de la reponse, la lit PAR BLOCS (titres,
 * paragraphes, puces) et la renvoie au service worker, qui referme la fenetre.
 * Le resume s'affiche ensuite dans YouTube, a cote de la video.
 *
 * Repris de Google More (tools/gemini-rewrite/gemini.js), qui pilote la meme
 * page. Reperes verifies sur gemini.google.com en septembre 2026 :
 *  - zone de saisie : rich-textarea .ql-editor[contenteditable] (Quill). Seul
 *    document.execCommand('insertText') y ecrit correctement : un « coller »
 *    simule est ignore ;
 *  - bouton d'envoi : button[aria-label="Envoyer un message"] dans .send-button,
 *    remplace par un bouton « Arreter… » pendant la redaction ;
 *  - reponse : <model-response> … <message-content> .markdown ; le
 *    raisonnement est dans <model-thoughts>.
 * Si Google modifie sa page, il faut adapter ce fichier ET celui de Google More.
 */

(() => {
  if (globalThis.__yttoolsGemini) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s || '').replace(/\s+/g, '');
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const STOP_RE = /arr[êe]t|stop/i;
  // innerText n'existe pas partout (tests) ; une fois les blancs retires, il
  // donne le meme resultat que textContent.
  const texte = (el) => (el.innerText != null ? el.innerText : el.textContent) || '';

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  async function waitFor(fn, timeout, interval = 250) {
    const end = Date.now() + timeout;
    for (;;) {
      let v = null;
      try { v = fn(); } catch { v = null; }
      if (v) return v;
      if (Date.now() >= end) return null;
      await sleep(interval);
    }
  }

  /* ---------------------------------------------------------------- reperage */

  const EDITOR_SELECTORS = [
    'rich-textarea .ql-editor[contenteditable="true"]',
    '.ql-editor[contenteditable="true"]',
    '[role="textbox"][contenteditable="true"]'
  ];

  function findEditor() {
    for (const sel of EDITOR_SELECTORS) {
      const el = Array.from(document.querySelectorAll(sel)).find(visible);
      if (el) return el;
    }
    return null;
  }

  const inputScope = () =>
    document.querySelector('input-area-v2') || document.querySelector('input-container') || document.body;

  function findSendButton() {
    const buttons = Array.from(inputScope().querySelectorAll('button')).filter(visible);
    const label = (b) => b.getAttribute('aria-label') || '';
    return buttons.find((b) => /envoyer|send/i.test(label(b)))
      || buttons.find((b) => b.closest('.send-button') && !STOP_RE.test(label(b)))
      || null;
  }

  function isGenerating() {
    const buttons = Array.from(inputScope().querySelectorAll('button')).filter(visible);
    return buttons.some((b) => STOP_RE.test(b.getAttribute('aria-label') || '') || b.closest('.send-button.stop'));
  }

  const responses = () => Array.from(document.querySelectorAll('model-response'));

  const BODY_SELECTORS = [
    'message-content .markdown-main-panel',
    'message-content .markdown',
    '.markdown-main-panel',
    '.markdown',
    'message-content'
  ];

  function responseBody(resp) {
    for (const sel of BODY_SELECTORS) {
      const el = Array.from(resp.querySelectorAll(sel)).find((e) => !e.closest('model-thoughts'));
      if (el) return el;
    }
    return null;
  }

  function loginProblem() {
    if (location.hostname !== 'gemini.google.com') return true;
    return Array.from(document.querySelectorAll('a, button'))
      .some((b) => visible(b) && /^(se connecter|connexion|sign in)$/i.test((b.textContent || '').trim()));
  }

  /* ---------------------------------------------------------------- ecriture */

  function selectContents(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  async function insertPrompt(editor, prompt) {
    const want = norm(prompt);
    for (let essai = 0; essai < 2; essai++) {
      editor.focus();
      selectContents(editor);
      try { document.execCommand('insertText', false, prompt); } catch { /* repli plus bas */ }
      await sleep(300);
      if (norm(texte(editor)) === want) return;
    }
    // Repli : paragraphes ecrits directement (Quill suit les modifications du DOM).
    editor.innerHTML = prompt.split('\n').map((l) => `<p>${l ? escHtml(l) : '<br>'}</p>`).join('');
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await sleep(400);
    if (!norm(texte(editor)).startsWith(want.slice(0, 40))) {
      throw new Error('Impossible d’écrire dans la zone de saisie de Gemini.');
    }
  }

  function pressEnter(el) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      const ev = new KeyboardEvent(type, { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'keyCode', { get: () => 13 });
      Object.defineProperty(ev, 'which', { get: () => 13 });
      el.dispatchEvent(ev);
    }
  }

  async function send(editor, avant) {
    const parti = () => responses().length > avant || isGenerating() || norm(texte(editor)) === '';
    const btn = await waitFor(() => {
      const b = findSendButton();
      return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : null;
    }, 10000);
    if (btn) btn.click(); else pressEnter(editor);
    if (await waitFor(parti, 8000)) return;
    pressEnter(editor);
    if (await waitFor(parti, 8000)) return;
    throw new Error('Le message n’a pas pu être envoyé à Gemini.');
  }

  /* ---------------------------------------------------------------- lecture */

  /**
   * Une ligne de Markdown brut -> un bloc. Sert quand Gemini rend sa reponse
   * dans un bloc de code au lieu de la mettre en forme.
   */
  function blocDeLigne(ligne) {
    const t = ligne.trim();
    if (!t) return null;
    const h = t.match(/^#{1,6}\s+(.*)$/);
    if (h) return { type: 'h', text: clean(h[1].replace(/\*\*/g, '')) };
    const li = t.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (li) return { type: 'li', text: clean(li[1].replace(/\*\*/g, '')) };
    return { type: 'p', text: clean(t.replace(/\*\*/g, '')) };
  }

  /**
   * La reponse en blocs { type: 'h' | 'p' | 'li', text }.
   *
   * On lit la STRUCTURE rendue par Gemini plutot que son texte a plat : un
   * titre « ## Points cles » devient un <h2> dont le texte ne garde aucun
   * diese. Relire le DOM est donc le seul moyen de savoir ce qui etait un
   * titre, une puce ou un paragraphe — et de le reconstruire proprement dans
   * YouTube.
   */
  function readBlocks(body) {
    const clone = body.cloneNode(true);
    clone.querySelectorAll(
      'model-thoughts, mat-icon, button, sup, source-footnote, sources-carousel-inline, .code-block-decoration'
    ).forEach((n) => n.remove());

    const blocs = [];
    const pousse = (b) => { if (b && b.text) blocs.push(b); };

    const parcours = (el) => {
      for (const n of Array.from(el.children)) {
        const tag = n.tagName;
        if (/^H[1-6]$/.test(tag)) {
          pousse({ type: 'h', text: clean(n.textContent) });
        } else if (tag === 'P') {
          // Un paragraphe entierement en gras fait office de titre.
          const seul = n.children.length === 1 && /^(STRONG|B)$/.test(n.children[0].tagName) &&
                       clean(n.children[0].textContent) === clean(n.textContent);
          pousse({ type: seul ? 'h' : 'p', text: clean(n.textContent) });
        } else if (tag === 'UL' || tag === 'OL') {
          for (const li of Array.from(n.children)) {
            if (li.tagName !== 'LI') continue;
            const copie = li.cloneNode(true);
            copie.querySelectorAll('ul, ol').forEach((x) => x.remove());
            pousse({ type: 'li', text: clean(copie.textContent) });
            Array.from(li.children).filter((c) => /^(UL|OL)$/.test(c.tagName))
              .forEach((sous) => parcours({ children: [sous] }));
          }
        } else if (tag === 'PRE') {
          (n.textContent || '').split('\n').map(blocDeLigne).forEach(pousse);
        } else if (tag === 'HR' || tag === 'TABLE') {
          // Rien d'utile pour un resume : on passe.
        } else {
          parcours(n);
        }
      }
    };
    parcours(clone);

    // Rien de structure (texte nu) : on decoupe par lignes.
    if (!blocs.length) (body.textContent || '').split('\n').map(blocDeLigne).forEach(pousse);
    return blocs;
  }

  async function waitForCompletion(resp, deadline) {
    let dernier = null;
    let stableDepuis = Date.now();
    while (Date.now() < deadline) {
      const body = responseBody(resp);
      const t = body ? norm(body.textContent) : '';
      const now = Date.now();
      if (t !== dernier) { dernier = t; stableDepuis = now; }
      const fini = !!resp.querySelector('message-actions');
      if (t && !isGenerating() && ((fini && now - stableDepuis >= 800) || now - stableDepuis >= 3000)) {
        return readBlocks(body);
      }
      await sleep(700);
    }
    throw new Error('Gemini met trop de temps à répondre.');
  }

  async function run(prompt, timeoutMs = 180000) {
    const deadline = Date.now() + timeoutMs;

    const editor = await waitFor(findEditor, 30000, 300);
    if (!editor) throw new Error(loginProblem() ? 'login' : 'Zone de saisie de Gemini introuvable.');

    await insertPrompt(editor, prompt);
    const avant = responses().length;
    await send(editor, avant);

    const resp = await waitFor(() => {
      const toutes = responses();
      return toutes.length > avant ? toutes[toutes.length - 1] : null;
    }, 60000, 400);
    if (!resp) throw new Error('Gemini n’a pas répondu (limite atteinte ou page inhabituelle).');

    return waitForCompletion(resp, deadline);
  }

  globalThis.__yttoolsGemini = { run, readBlocks, blocDeLigne };

  /* ------------------------------------------------- liaison avec l'extension */

  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;

  const port = chrome.runtime.connect({ name: 'yttools-gemini' });
  // Messages reguliers : sans eux, le service worker s'endort apres 30 s
  // d'inactivite et la reponse de Gemini n'arrive jamais a YouTube.
  const veille = setInterval(() => { try { port.postMessage({ type: 'ping' }); } catch { /* port ferme */ } }, 4000);

  port.onDisconnect.addListener(() => clearInterval(veille));
  port.onMessage.addListener(async (msg) => {
    if (!msg || msg.type !== 'start') return;
    try {
      if (loginProblem()) throw new Error('login');
      const blocs = await run(msg.prompt, msg.timeoutMs);
      port.postMessage({ type: 'done', blocks: blocs });
    } catch (e) {
      try { port.postMessage({ type: 'error', error: String((e && e.message) || e) }); } catch { /* port ferme */ }
    } finally {
      clearInterval(veille);
    }
  });
})();
