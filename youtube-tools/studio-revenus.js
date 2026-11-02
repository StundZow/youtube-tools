'use strict';

/**
 * YouTube Studio — masquer les revenus.
 *
 * Reglage « Masquer les revenus » du popup : chaque montant affiche par Studio
 * est floute, et un clic dessus l'affiche. Pour filmer ou partager son ecran
 * sans devoiler ses gains.
 *
 * Un montant se reconnait a ce qu'il DIT : un element dont TOUT le texte est
 * une somme (« 2 247,57 € », « US$1.2K », « +12,30 € »). Un titre de video qui
 * cite un prix (« J'ai achete un truc a 100 € ») n'est donc jamais floute.
 *
 * Le marquage se fait dans le rappel du MutationObserver, qui passe AVANT
 * l'affichage : un montant qui arrive (infobulle d'un graphique, changement de
 * periode) ne s'affiche jamais en clair, meme une image.
 *
 * Aucune requete : on ne fait que poser une classe sur des elements de la page.
 */

(() => {
  if (window.__yttoolsMoney) return;
  const TV = window.__yttools;
  if (!TV) return;

  const ON = 'yttools-hide-money';       // sur <html> : le reglage est actif
  const CLS = 'yttools-money';           // sur chaque montant
  const SHOWN = 'yttools-money-shown';   // montant devoile d'un clic

  const CUR = '(?:[A-Z]{0,3}[$€£¥₹₩₽₺₪₫]|EUR|USD|GBP|CHF|CAD|AUD|JPY)';
  const NUM = "\\d[\\d .,']*(?: ?(?:k|K|M|Md|md|Mrd|B|Bn|Mio))?";
  const MONEY = new RegExp(`^[+\\-−–~≈]? ?(?:${CUR} ?${NUM}|${NUM} ?${CUR})$`);
  const MAX = 32;                        // au-dela, c'est une phrase, pas un montant

  const norm = (s) => String(s || '').replace(/[\s   ]+/g, ' ').trim();

  function estMontant(texte) {
    const t = norm(texte);
    return t.length <= MAX && MONEY.test(t);
  }

  let actif = false;

  /**
   * Le plus petit element qui porte le montant ENTIER. Le chiffre et la devise
   * sont parfois dans deux balises voisines : on remonte de quelques niveaux.
   */
  function examine(texte) {
    if (!/\d/.test(texte.nodeValue || '')) return;
    let el = texte.parentElement;
    for (let i = 0; i < 3 && el && el !== document.body; i++, el = el.parentElement) {
      if (/^(SCRIPT|STYLE|TEXTAREA|INPUT|HTML)$/.test(el.tagName)) return;
      const t = norm(el.textContent);
      if (t.length > MAX) return;
      if (MONEY.test(t)) {
        // En SVG, c'est la balise <text> qui s'affiche, pas son <tspan>.
        const cible = (el.closest && el.closest('text')) || el;
        if (!cible.classList.contains(CLS)) cible.classList.add(CLS);
        return;
      }
    }
  }

  function scanne(racine) {
    if (!racine) return;
    if (racine.nodeType === 3) { examine(racine); return; }
    if (racine.nodeType !== 1 && racine.nodeType !== 9 && racine.nodeType !== 11) return;
    const w = document.createTreeWalker(racine, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) examine(n);
  }

  /** Un element reutilise par Studio peut cesser d'etre un montant : on retire la marque. */
  function reverifie(el) {
    const m = el && el.closest ? el.closest('.' + CLS) : null;
    if (m && !estMontant(m.textContent)) m.classList.remove(CLS, SHOWN);
  }

  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'characterData') {
        reverifie(m.target.parentElement);
        examine(m.target);
      } else {
        reverifie(m.target.nodeType === 1 ? m.target : m.target.parentElement);
        m.addedNodes.forEach(scanne);
      }
    }
  });

  function applique() {
    const on = !!TV.settings.get().hideRevenue;
    document.documentElement.classList.toggle(ON, on);
    if (on && !actif) {
      actif = true;
      obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      scanne(document.documentElement);
    } else if (!on && actif) {
      actif = false;
      obs.disconnect();
    }
  }

  // Un clic devoile le montant. Le clic est consomme : un montant pose sur un
  // onglet ou un lien ne doit pas, en plus, changer de page. Un second clic,
  // sur le montant devoile, agit normalement.
  document.addEventListener('click', (e) => {
    if (!actif) return;
    const m = e.target && e.target.closest ? e.target.closest('.' + CLS) : null;
    if (!m || m.classList.contains(SHOWN)) return;
    e.preventDefault();
    e.stopPropagation();
    m.classList.add(SHOWN);
  }, true);

  TV.settings.onChange(applique);
  TV.settings.ready.then(applique);

  window.__yttoolsMoney = { estMontant, scanne };
})();
