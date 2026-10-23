'use strict';

/**
 * YouTube Tools — classement sur 10 : coeur de calcul.
 *
 * Une video est comparee aux 9 que sa chaine a publiees juste avant elle. Les
 * plus anciennes ayant eu plus de temps pour accumuler des vues, on estime
 * combien chacune en avait AU MEME AGE que la video regardee, avec une courbe
 * de croissance type. On trie : la position obtenue est le « X sur 10 ».
 *
 * EXCEPTION ASSUMEE au principe du reste de l'extension (« aucune requete vers
 * YouTube ») : la liste des videos d'une chaine n'est pas dans la page, il faut
 * la demander a /youtubei/v1/browse. Pour rester discret :
 *  - requetes publiques uniquement, SANS cookie (credentials: 'omit') : rien ne
 *    touche a la session, aucun identifiant n'est lu ni envoye ;
 *  - liste gardee 6 h par chaine : regarder dix videos d'une meme chaine ne
 *    coute qu'une poignee de requetes ;
 *  - uniquement sur une page de lecture, et seulement si le reglage est actif.
 *
 * Aucune dependance au DOM : ce fichier tourne tel quel sous Node pour les
 * tests (tests/rank-core.test.js).
 *
 * Modele et parametres repris de Better YouTube Studio (SQUIDUU), dont c'est la
 * fonction « Classement sur 10 des videos », pour obtenir les memes rangs.
 */

(function (root) {
  if (root.__yttoolsRank) return;

  // Onglets de chaine (parametres protobuf de YouTube) : du plus recent au plus ancien.
  const TAB_PARAMS = { video: 'EgZ2aWRlb3PyBgQKAjoA', short: 'EgZzaG9ydHPyBgUKA5oBAA==' };

  const COMPARED  = 9;            // la video + ses 9 predecesseures = classement sur 10
  const MIN_OLDER = 2;            // en dessous, un classement n'a pas de sens
  const MIN_AGE_H = 24;           // avant 24 h, l'estimation est trop instable
  const MAX_PAGES = 20;           // ~600 videos : au-dela, la video est trop ancienne
  const CACHE_MS  = 6 * 3600e3;   // liste d'une chaine gardee 6 h
  const STALE_MS  = 10 * 60e3;    // cache de plus de 10 min et video absente : on recharge une fois

  /**
   * Part des vues « a vie » atteinte a l'age h (en heures). Fonction de Hill :
   * la moitie est atteinte a 2 jours, avec une pente de 0,9. Une video vieille
   * de 10 jours n'avait donc a 2 jours qu'environ 58 % de ses vues d'aujourd'hui.
   */
  const SLOPE = 0.9;
  const HALF_DAYS = 2;
  function growth(hours) {
    const x = Math.pow(Math.max(hours, 1) / 24, SLOPE);
    return x / (x + Math.pow(HALF_DAYS, SLOPE));
  }

  /* --------------------------------------------------------------- lecture */

  function textOf(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v.content === 'string') return v.content;
    if (typeof v.simpleText === 'string') return v.simpleText;
    if (Array.isArray(v.runs)) return v.runs.map((r) => r.text || '').join('');
    return '';
  }

  // La liste est demandee en anglais : « 1.2M views », « 12K views », « 1,234 views », « No views ».
  function parseViews(s) {
    const t = String(s || '').trim();
    if (/^no views?\b/i.test(t)) return 0;
    const m = t.replace(/,/g, '').match(/([\d.]+)\s*([KMB])?/i);
    if (!m) return null;
    const n = parseFloat(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1);
    return Number.isFinite(n) ? n : null;
  }

  // « 3 days ago », « Streamed 2 weeks ago » -> heures. « 3 jours » veut dire
  // entre 3 et 4 : on prend le milieu de la tranche.
  const UNIT_H = { second: 1 / 3600, minute: 1 / 60, hour: 1, day: 24, week: 168, month: 730, year: 8766 };
  function parseAgeHours(s) {
    const m = String(s || '').match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i);
    return m ? (Number(m[1]) + 0.5) * UNIT_H[m[2].toLowerCase()] : null;
  }

  function parseItems(list, fetchedAt) {
    const items = [];
    let token = null;
    for (const it of list || []) {
      const cont = it && it.continuationItemRenderer && it.continuationItemRenderer.continuationEndpoint &&
        it.continuationItemRenderer.continuationEndpoint.continuationCommand;
      if (cont && cont.token) { token = cont.token; continue; }

      const content = (it && it.richItemRenderer && it.richItemRenderer.content) || {};

      const sh = content.shortsLockupViewModel;
      if (sh) {
        const id = (JSON.stringify(sh.onTap || {}).match(/"videoId":"([\w-]{11})"/) || [])[1];
        const om = sh.overlayMetadata || {};
        // Les Shorts n'affichent pas de date dans la liste : age inconnu.
        if (id) items.push({ id, title: textOf(om.primaryText), views: parseViews(textOf(om.secondaryText)), ageHours: null, fetchedAt });
        continue;
      }

      const lk = content.lockupViewModel;
      if (!lk || !lk.contentId) continue;
      if (lk.contentType && lk.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') continue;
      const meta = (lk.metadata && lk.metadata.lockupMetadataViewModel) || {};
      const cmv = meta.metadata && meta.metadata.contentMetadataViewModel;
      const parts = ((cmv && cmv.metadataRows) || []).flatMap((r) => (r.metadataParts || []).map((p) => textOf(p.text)));
      // Un direct en cours affiche « watching » : sans le mot « views », il est ecarte.
      const viewsPart = parts.find((p) => /\bviews?\b/i.test(p));
      const age = parts.map(parseAgeHours).find((h) => h != null);
      items.push({
        id: lk.contentId,
        title: textOf(meta.title),
        views: viewsPart ? parseViews(viewsPart) : null,
        ageHours: age == null ? null : age,
        fetchedAt
      });
    }
    return { items, token };
  }

  /* ---------------------------------------------------------------- reseau */

  async function browse(deps, body, hl = 'en') {
    const url = `${deps.base || ''}/youtubei/v1/browse?prettyPrint=false&key=${encodeURIComponent(deps.cfg.key)}`;
    const res = await deps.fetch(url, {
      method: 'POST',
      credentials: 'omit',                 // aucun cookie : uniquement des donnees publiques
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        context: { client: { clientName: 'WEB', clientVersion: deps.cfg.version, hl, ...(hl === 'en' ? { gl: 'US' } : {}) } },
        ...body
      })
    });
    if (!res.ok) throw new Error(`browse HTTP ${res.status}`);
    return res.json();
  }

  function rawItems(json, continuation) {
    if (continuation) {
      return [...(json.onResponseReceivedActions || []), ...(json.onResponseReceivedEndpoints || [])]
        .flatMap((a) => (a.appendContinuationItemsAction && a.appendContinuationItemsAction.continuationItems) ||
                        (a.reloadContinuationItemsCommand && a.reloadContinuationItemsCommand.continuationItems) || []);
    }
    const tabs = (json.contents && json.contents.twoColumnBrowseResultsRenderer &&
                  json.contents.twoColumnBrowseResultsRenderer.tabs) || [];
    const sel = tabs.find((t) => t.tabRenderer && t.tabRenderer.selected);
    return (sel && sel.tabRenderer.content && sel.tabRenderer.content.richGridRenderer &&
            sel.tabRenderer.content.richGridRenderer.contents) || [];
  }

  function fetchPage(deps, channel, kind, token, hl) {
    return token
      ? browse(deps, { continuation: token }, hl)
      : browse(deps, { browseId: channel, params: TAB_PARAMS[kind] }, hl);
  }

  /* ------------------------------------------------------------------ cache */

  const memo = new Map();
  const titleMemo = new Map();
  const locks = new Map();
  const keyOf = (channel, kind) => `yttoolsRank:${channel}:${kind}`;

  function newState(channel, kind, now) {
    return { channel, kind, at: now, items: [], token: null, pages: 0, done: false };
  }

  function getState(channel, kind, deps) {
    const key = keyOf(channel, kind);
    const now = deps.now();
    let st = memo.get(key);
    if (st && now - st.at < CACHE_MS) return st;
    try { st = JSON.parse((deps.storage && deps.storage.getItem(key)) || 'null'); } catch { st = null; }
    if (!st || now - st.at >= CACHE_MS) st = newState(channel, kind, now);
    memo.set(key, st);
    return st;
  }

  function saveState(st, deps) {
    try { if (deps.storage) deps.storage.setItem(keyOf(st.channel, st.kind), JSON.stringify(st)); } catch { /* quota plein : sans gravite */ }
  }

  function resetState(channel, kind, deps) {
    const st = newState(channel, kind, deps.now());
    memo.set(keyOf(channel, kind), st);
    return st;
  }

  // Une seule recherche a la fois par chaine : deux onglets de la meme chaine
  // ne chargent pas deux fois les memes pages.
  function withLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    locks.set(key, run.catch(() => {}));
    return run;
  }

  async function loadPage(st, deps) {
    const json = await fetchPage(deps, st.channel, st.kind, st.token, 'en');
    const page = parseItems(rawItems(json, !!st.token), deps.now());
    const known = new Set(st.items.map((i) => i.id));
    st.items.push(...page.items.filter((i) => !known.has(i.id)));
    st.token = page.token;
    st.pages += 1;
    st.done = !page.token || st.pages >= MAX_PAGES;
  }

  // Charge des pages jusqu'a trouver la video ET ses 9 predecesseures dotees d'un nombre de vues.
  async function findWithHistory(st, videoId, deps) {
    for (;;) {
      const i = st.items.findIndex((x) => x.id === videoId);
      if (i >= 0) {
        const older = st.items.slice(i + 1).filter((x) => x.views != null);
        if (older.length >= COMPARED || st.done) return { target: st.items[i], older: older.slice(0, COMPARED) };
      } else if (st.done) {
        return null;
      }
      await loadPage(st, deps);
    }
  }

  /**
   * La liste est lue en anglais pour fiabiliser les nombres, ce qui renvoie les
   * titres TRADUITS par YouTube (« WHO IS THE IMPOSTER? »). On relit donc les
   * memes pages dans la langue de l'utilisateur, rien que pour les titres.
   */
  async function localizedTitles(channel, kind, ids, maxPages, lang, deps) {
    if (!lang || /^en\b/i.test(lang) || !ids.length) return {};
    const key = `${channel}:${kind}:${lang}`;
    let st = titleMemo.get(key);
    if (!st || deps.now() - st.at > CACHE_MS) {
      st = { at: deps.now(), titles: {}, token: null, pages: 0, done: false };
      titleMemo.set(key, st);
    }
    while (!st.done && st.pages < Math.max(1, maxPages) && ids.some((id) => !(id in st.titles))) {
      const json = await fetchPage(deps, channel, kind, st.token, lang);
      const page = parseItems(rawItems(json, !!st.token), deps.now());
      page.items.forEach((it) => { if (it.title) st.titles[it.id] = it.title; });
      st.token = page.token;
      st.pages += 1;
      st.done = !page.token;
    }
    return st.titles;
  }

  /* ------------------------------------------------------------- classement */

  function rank(current, found, kind, now) {
    const curAge = current.published ? Math.max(0, (now - current.published) / 3600e3) : null;
    if (curAge != null && curAge < MIN_AGE_H) return { status: 'too-early', ageHours: curAge };

    const entries = [{
      id: current.id,
      title: current.title || found.target.title || '',
      // Le compteur exact de la page plutot que l'arrondi de la liste (« 1.2M »)
      views: current.views != null ? current.views : (found.target.views || 0),
      current: true,
      estimated: false
    }];
    for (const o of found.older) {
      const oAge = o.ageHours == null ? null : o.ageHours + (now - o.fetchedAt) / 3600e3;
      // Shorts : la liste ne donne pas d'age, on compare donc les vues actuelles.
      const scale = kind === 'video' && curAge != null && oAge != null;
      entries.push({
        id: o.id,
        title: o.title,
        views: scale ? o.views * growth(curAge) / growth(oAge) : o.views,
        current: false,
        estimated: scale
      });
    }
    entries.sort((a, b) => b.views - a.views);
    return { status: 'ok', entries, position: entries.findIndex((e) => e.current) + 1, total: entries.length, ageHours: curAge, kind };
  }

  /**
   * current : { id, channel, views, published (ms), live, short, title }
   * deps    : { fetch, base, cfg: { key, version }, now, storage, lang }
   *
   * Statuts : ok | too-early | live | not-found | not-enough | no-channel | no-config
   */
  async function computeRanking(current, deps) {
    if (current.live) return { status: 'live' };
    if (!/^UC[\w-]{22}$/.test(current.channel || '')) return { status: 'no-channel' };
    if (!deps.cfg || !deps.cfg.key) return { status: 'no-config' };
    const kind = current.short ? 'short' : 'video';

    return withLock(keyOf(current.channel, kind), async () => {
      let st = getState(current.channel, kind, deps);
      let found = await findWithHistory(st, current.id, deps);
      // Video recente absente d'une liste en cache : on recharge la liste une fois.
      if (!found && deps.now() - st.at > STALE_MS) {
        st = resetState(current.channel, kind, deps);
        found = await findWithHistory(st, current.id, deps);
      }
      saveState(st, deps);
      if (!found) return { status: 'not-found' };
      if (found.older.length < MIN_OLDER) return { status: 'not-enough' };

      const result = rank(current, found, kind, deps.now());
      if (result.status === 'ok') {
        try {
          const titles = await localizedTitles(current.channel, kind,
            result.entries.filter((e) => !e.current).map((e) => e.id), st.pages, deps.lang, deps);
          result.entries.forEach((e) => { if (!e.current && titles[e.id]) e.title = titles[e.id]; });
        } catch { /* titres en anglais plutot que pas de classement du tout */ }
      }
      return result;
    });
  }

  const api = { computeRanking, rank, growth, parseViews, parseAgeHours, parseItems, TAB_PARAMS, COMPARED };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.__yttoolsRank = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
