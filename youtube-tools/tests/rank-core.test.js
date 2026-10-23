// Test du coeur de calcul contre de vraies chaines YouTube (donnees publiques).
// Usage : node tests/rank-core.test.js
const C = require('../rank-core.js');

let echecs = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'OK  ' : 'ECHEC'}  ${msg}`); if (!cond) echecs++; };

async function config() {
  const res = await fetch('https://www.youtube.com/?hl=en&gl=US', {
    credentials: 'omit',
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36', 'accept-language': 'en-US,en' }
  });
  const html = await res.text();
  return {
    key: (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1],
    version: (html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1]
  };
}

async function premierePage(cfg, channel, kind) {
  const res = await fetch(`https://www.youtube.com/youtubei/v1/browse?prettyPrint=false&key=${cfg.key}`, {
    method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: cfg.version, hl: 'en', gl: 'US' } }, browseId: channel, params: C.TAB_PARAMS[kind] })
  });
  const json = await res.json();
  const tab = (json.contents?.twoColumnBrowseResultsRenderer?.tabs || []).find(t => t.tabRenderer?.selected);
  return C.parseItems(tab?.tabRenderer?.content?.richGridRenderer?.contents || [], Date.now());
}

function affiche(r) {
  if (r.status !== 'ok') { console.log(`     -> statut : ${r.status}`); return; }
  const age = r.ageHours == null ? '?' : `${Math.round(r.ageHours / 24)} j`;
  console.log(`     -> ${r.position} sur ${r.total}   (age ${age}, ${r.kind})`);
  r.entries.forEach((e, i) => console.log(`        ${String(i + 1).padStart(2)}. ${e.current ? '>>' : '  '} ${(e.estimated ? '~' : ' ')}${Math.round(e.views).toLocaleString('fr-FR').padStart(13)}  ${e.title.slice(0, 60)}`));
}

(async () => {
  console.log('\n=== 1. Fonctions pures ===');
  ok(C.parseViews('1.2M views') === 1.2e6, 'parseViews 1.2M');
  ok(C.parseViews('12K views') === 12e3, 'parseViews 12K');
  ok(C.parseViews('1,234 views') === 1234, 'parseViews 1,234');
  ok(C.parseViews('No views') === 0, 'parseViews No views');
  ok(C.parseViews('847 watching') === 847, 'parseViews ne sert que sur la partie "views" (filtrage en amont)');
  ok(Math.abs(C.parseAgeHours('3 days ago') - 84) < 1e-9, 'parseAgeHours 3 days -> 84 h');
  ok(Math.abs(C.parseAgeHours('Streamed 2 weeks ago') - 420) < 1e-9, 'parseAgeHours Streamed 2 weeks');
  ok(C.parseAgeHours('Premieres 10/30/26') === null, 'parseAgeHours date future -> null');
  ok(Math.abs(C.growth(48) - 0.5) < 1e-9, 'growth : moitie des vues a 2 jours');
  ok(C.growth(24) < C.growth(240) && C.growth(240) < 1, 'growth croissante et bornee');

  console.log('\n=== 2. Classement a la main (donnees inventees) ===');
  const now = Date.now();
  const fake = {
    target: { id: 'cur', title: 'Courante', views: 1000 },
    older: [
      { id: 'a', title: 'A', views: 5000, ageHours: 240, fetchedAt: now },   // 10 j
      { id: 'b', title: 'B', views: 800,  ageHours: 48,  fetchedAt: now }    // 2 j
    ]
  };
  const r = C.rank({ id: 'cur', views: 1000, published: now - 48 * 3600e3, title: 'Courante' }, fake, 'video', now);
  // a 2 jours : A aurait eu 5000 * growth(48)/growth(240) ~ 2900 ; B 800 ; courante 1000
  ok(r.status === 'ok' && r.total === 3, 'trois entrees');
  ok(r.position === 2, `la courante est 2e (obtenu : ${r.position})`);
  ok(C.rank({ id: 'cur', views: 1, published: now - 3600e3 }, fake, 'video', now).status === 'too-early', 'moins de 24 h -> too-early');

  console.log('\n=== 3. En vrai, contre YouTube ===');
  const cfg = await config();
  ok(!!cfg.key && !!cfg.version, `cle et version recuperees (version ${cfg.version})`);
  const deps = { fetch, base: 'https://www.youtube.com', cfg, now: Date.now, storage: null };

  const chaines = [
    ['UCX6OQ3DkcsbYNE6H8uQQuVA', 'MrBeast'],
    ['UCWeg2Pkate69NFdBeuRFTAw', 'Squeezie']
  ];
  for (const [ch, nom] of chaines) {
    for (const kind of ['video', 'short']) {
      const page = await premierePage(cfg, ch, kind);
      const avecVues = page.items.filter(i => i.views != null);
      console.log(`\n  ${nom} / ${kind} : ${page.items.length} elements sur la 1re page, ${avecVues.length} avec vues, continuation=${!!page.token}`);
      ok(page.items.length > 0, `${nom} ${kind} : liste non vide`);
      if (kind === 'video') ok(page.items.slice(0, 5).every(i => i.ageHours != null), `${nom} : age lisible sur les 5 premieres`);
      const cible = avecVues[3];
      if (!cible) continue;
      const published = cible.ageHours != null ? Date.now() - cible.ageHours * 3600e3 : null;
      console.log(`     video testee : "${cible.title.slice(0, 50)}"  (${cible.views} vues)`);
      const res = await C.computeRanking({ id: cible.id, channel: ch, views: cible.views, published, live: false, short: kind === 'short', title: cible.title }, deps);
      ok(res.status === 'ok' && res.total === 10, `${nom} ${kind} : classement sur 10 calcule`);
      affiche(res);
    }
  }

  console.log('\n=== 4. Titres dans la langue de l\'utilisateur, et cache ===');
  // Compteur de requetes : le cache doit eviter de tout redemander.
  let appels = 0;
  const compte = (url, opts) => { appels++; return fetch(url, opts); };
  const page = await premierePage(cfg, 'UCWeg2Pkate69NFdBeuRFTAw', 'video');
  const cible = page.items.filter(i => i.views != null && i.ageHours != null)[2];
  if (cible) {
    const cur = { id: cible.id, channel: 'UCWeg2Pkate69NFdBeuRFTAw', views: cible.views, published: Date.now() - cible.ageHours * 3600e3, live: false, short: false, title: cible.title };
    const fr = await C.computeRanking(cur, { ...deps, fetch: compte, lang: 'fr' });
    ok(fr.status === 'ok', 'classement avec titres en francais');
    const anglais = new Map(page.items.map(i => [i.id, i.title]));
    const traduits = fr.entries.filter(e => !e.current && anglais.has(e.id) && anglais.get(e.id) !== e.title).length;
    ok(traduits > 0, `titres relus en francais (${traduits} differents de la version anglaise)`);
    ok(fr.entries.every(e => e.title), 'aucun titre vide');
    const avant = appels;
    const encore = await C.computeRanking(cur, { ...deps, fetch: compte, lang: 'fr' });
    ok(encore.status === 'ok' && appels === avant, `2e calcul servi par le cache (${appels - avant} requete)`);
    affiche(fr);
  }

  console.log(`\n=== ${echecs ? echecs + ' ECHEC(S)' : 'TOUT EST VERT'} ===\n`);
  process.exit(echecs ? 1 : 0);
})().catch(e => { console.error('ERREUR', e); process.exit(2); });
