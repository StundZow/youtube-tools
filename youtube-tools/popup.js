'use strict';

const KEY = 'yttools';
// Noms portes par l'extension avant « YouTube Tools », du plus recent au plus
// ancien : on relit ces cles pour ne pas perdre les champs deja saisis.
const OLD_KEYS = ['thumbview', 'prevyou'];

// Reglages des boutons injectes dans YouTube. Cle separee des champs d'apercu :
// les scripts de contenu ne lisent que celle-ci, et l'aperçu reste ponctuel.
const SETTINGS_KEY = 'yttoolsSettings';
const OLD_SETTINGS_KEYS = ['thumbviewSettings'];
const SETTINGS_DEFAULTS = {
  transcriptButton: true,
  videosButton: true,
  saveAsFile: false
};
let settings = { ...SETTINGS_DEFAULTS };
const DEFAULTS = {
  channel: '',
  title: '',
  thumb: '',
  avatar: '',
  random: false,
  theme: 'light'
};

const $ = (id) => document.getElementById(id);
const el = {
  theme: $('theme'), reset: $('reset'),
  avatarBtn: $('avatarBtn'), avatarImg: $('avatarImg'), avatarFile: $('avatarFile'),
  channel: $('channel'),
  drop: $('drop'), thumbImg: $('thumbImg'), thumbFile: $('thumbFile'),
  clearThumb: $('clearThumb'), thumbInfo: $('thumbInfo'),
  title: $('videoTitle'), titleCount: $('titleCount'),
  random: $('randomPos'),
  preview: $('preview'), remove: $('remove'), status: $('status'),
  setTranscript: $('setTranscript'), setVideos: $('setVideos'), setSaveFile: $('setSaveFile')
};

let state = { ...DEFAULTS };
// Un aperçu est affiché sur l'onglet YouTube courant. Jamais persisté : il ne
// vit que sur la page où on a cliqué, et disparaît dès qu'on navigue.
let live = false;

/* ------------------------------------------------------------------ state */

/** La premiere cle presente dans le stockage, en partant de la plus recente. */
function reprise(stored, keys) {
  for (const k of keys) if (stored[k]) return { valeur: stored[k], cle: k };
  return { valeur: null, cle: null };
}

async function load() {
  const toutes = [KEY, ...OLD_KEYS, SETTINGS_KEY, ...OLD_SETTINGS_KEYS];
  const stored = await chrome.storage.local.get(toutes);

  // Renommer l'extension ne doit pas faire perdre ce qui a deja ete saisi : on
  // reprend la plus recente des anciennes cles, puis on la supprime.
  const champs = reprise(stored, [KEY, ...OLD_KEYS]);
  state = { ...DEFAULTS, ...(champs.valeur || {}) };
  delete state.enabled;                       // résidu des anciennes versions

  const regl = reprise(stored, [SETTINGS_KEY, ...OLD_SETTINGS_KEYS]);
  settings = { ...SETTINGS_DEFAULTS, ...(regl.valeur || {}) };

  const perimees = [];
  if (champs.cle && champs.cle !== KEY) {
    await chrome.storage.local.set({ [KEY]: state });
    perimees.push(champs.cle);
  }
  if (regl.cle && regl.cle !== SETTINGS_KEY) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    perimees.push(regl.cle);
  }
  if (perimees.length) await chrome.storage.local.remove(perimees);

  render();
  live = await ping();
  render();
}

/** Les scripts de contenu suivent cette cle : ecrire suffit a tout mettre a jour. */
async function saveSettings(patch) {
  settings = { ...settings, ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  render();
}

/** L'onglet YouTube affiche-t-il un aperçu en ce moment ? */
async function ping() {
  const tab = await youtubeTab();
  if (!tab) return false;
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'YTTOOLS_PING' });
    return !!(res && res.injected);
  } catch {
    return false;                             // content script pas encore chargé
  }
}

async function save(patch = {}) {
  state = { ...state, ...patch };
  await chrome.storage.local.set({ [KEY]: state });
}

function render() {
  document.documentElement.dataset.theme = state.theme;

  if (el.channel.value !== state.channel) el.channel.value = state.channel;
  if (el.title.value !== state.title) el.title.value = state.title;
  el.titleCount.textContent = state.title.length;

  el.random.setAttribute('aria-checked', String(!!state.random));

  el.setTranscript.setAttribute('aria-checked', String(!!settings.transcriptButton));
  el.setVideos.setAttribute('aria-checked', String(!!settings.videosButton));
  el.setSaveFile.setAttribute('aria-checked', String(!!settings.saveAsFile));

  setImg(el.thumbImg, state.thumb);
  el.drop.classList.toggle('filled', !!state.thumb);
  el.clearThumb.hidden = !state.thumb;

  setImg(el.avatarImg, state.avatar);

  el.remove.hidden = !live;
  el.preview.innerHTML = '';
  const eyes = document.createElement('span');
  eyes.className = 'eyes';
  eyes.textContent = '\u{1F440}';
  el.preview.append(eyes, ' ' + (live ? 'Mettre à jour l’aperçu' : 'Aperçu'));
}

function setImg(node, dataUrl) {
  if (dataUrl) { node.src = dataUrl; node.hidden = false; }
  else { node.removeAttribute('src'); node.hidden = true; }
}

function status(msg, kind = '') {
  el.status.textContent = msg;
  el.status.className = 'status ' + kind;
  if (msg) setTimeout(() => { if (el.status.textContent === msg) el.status.textContent = ''; }, 4000);
}

/* ------------------------------------------------------------------ images */

const MAX_W = { thumb: 1280, avatar: 144 };

function readFile(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('Lecture du fichier impossible'));
    fr.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image illisible'));
    img.src = src;
  });
}

/** Redimensionne dans un canvas -> dataURL compact (webp, repli jpeg). */
async function process(file, kind) {
  if (!file || !file.type.startsWith('image/')) throw new Error('Ce fichier n’est pas une image');
  const raw = await readFile(file);
  const img = await loadImage(raw);

  const max = MAX_W[kind];
  const scale = Math.min(1, max / img.naturalWidth);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);

  let out = canvas.toDataURL('image/webp', 0.9);
  if (!out.startsWith('data:image/webp')) out = canvas.toDataURL('image/jpeg', 0.92);

  // chrome.storage.local plafonne vers 10 Mo : on reste tres en dessous.
  let q = 0.8;
  while (out.length > 2500000 && q > 0.35) {
    out = canvas.toDataURL('image/webp', q);
    q -= 0.15;
  }

  return { dataUrl: out, w: img.naturalWidth, h: img.naturalHeight };
}

async function setThumb(file) {
  try {
    const { dataUrl, w, h } = await process(file, 'thumb');
    await save({ thumb: dataUrl });
    const off = Math.abs(w / h - 16 / 9) > 0.08;
    el.thumbInfo.textContent = w + '×' + h + (off ? ' — ratio ≠ 16:9, YouTube va rogner' : '');
    render();
  } catch (e) {
    status(e.message, 'err');
  }
}

async function setAvatar(file) {
  try {
    const { dataUrl } = await process(file, 'avatar');
    await save({ avatar: dataUrl });
    render();
  } catch (e) {
    status(e.message, 'err');
  }
}

/* ------------------------------------------------------------------ tab I/O */

async function youtubeTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && /^https:\/\/(www|m)\.youtube\.com\//.test(active.url || '')) return active;

  const [any] = await chrome.tabs.query({ url: ['https://www.youtube.com/*', 'https://m.youtube.com/*'] });
  return any || null;
}

/** Envoie un message, en injectant le content script s'il n'est pas encore la. */
async function send(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function apply() {
  if (!state.thumb && !state.title && !state.channel) {
    status('Ajoute au moins une miniature ou un titre', 'err');
    return;
  }

  const tab = await youtubeTab();
  if (!tab) {
    await chrome.tabs.create({ url: 'https://www.youtube.com/' });
    window.close();
    return;
  }

  try {
    const res = await send(tab.id, { type: 'YTTOOLS_APPLY', data: state });
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    if (res && res.ok) {
      live = true;
      window.close();
    } else {
      status('Aucune grille de vidéos trouvée sur cette page', 'err');
    }
  } catch {
    status('Recharge la page YouTube puis réessaie', 'err');
  }
}

async function removePreview() {
  live = false;
  render();
  const tab = await youtubeTab();
  if (tab) {
    try { await chrome.tabs.sendMessage(tab.id, { type: 'YTTOOLS_REMOVE' }); } catch { /* rien a retirer */ }
  }
  status('Aperçu retiré', 'ok');
}

/* ------------------------------------------------------------------ events */

el.theme.addEventListener('click', async () => {
  await save({ theme: state.theme === 'dark' ? 'light' : 'dark' });
  render();
});

el.reset.addEventListener('click', async () => {
  const theme = state.theme;
  state = { ...DEFAULTS, theme };
  await chrome.storage.local.set({ [KEY]: state });
  el.channel.value = '';
  el.title.value = '';
  el.thumbInfo.textContent = '';
  live = false;
  render();
  const tab = await youtubeTab();
  if (tab) {
    try { await chrome.tabs.sendMessage(tab.id, { type: 'YTTOOLS_REMOVE' }); } catch { /* noop */ }
  }
  status('Réinitialisé', 'ok');
});

el.channel.addEventListener('input', (e) => save({ channel: e.target.value }));
el.title.addEventListener('input', (e) => {
  el.titleCount.textContent = e.target.value.length;
  save({ title: e.target.value });
});

el.random.addEventListener('click', () => save({ random: !state.random }).then(render));

el.drop.addEventListener('click', () => el.thumbFile.click());
el.drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.thumbFile.click(); }
});
el.thumbFile.addEventListener('change', (e) => e.target.files[0] && setThumb(e.target.files[0]));

el.avatarBtn.addEventListener('click', () => el.avatarFile.click());
el.avatarFile.addEventListener('change', (e) => e.target.files[0] && setAvatar(e.target.files[0]));

el.clearThumb.addEventListener('click', async (e) => {
  e.stopPropagation();
  await save({ thumb: '' });
  el.thumbInfo.textContent = '';
  render();
});

['dragenter', 'dragover'].forEach((t) =>
  el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.add('over'); })
);
['dragleave', 'drop'].forEach((t) =>
  el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.remove('over'); })
);
el.drop.addEventListener('drop', (e) => {
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) setThumb(file);
});

document.addEventListener('paste', (e) => {
  const items = e.clipboardData ? [...e.clipboardData.items] : [];
  const item = items.find((i) => i.type.startsWith('image/'));
  if (item) setThumb(item.getAsFile());
});

el.preview.addEventListener('click', () => apply());
el.remove.addEventListener('click', removePreview);

el.setTranscript.addEventListener('click', () => saveSettings({ transcriptButton: !settings.transcriptButton }));
el.setVideos.addEventListener('click', () => saveSettings({ videosButton: !settings.videosButton }));
el.setSaveFile.addEventListener('click', () => saveSettings({ saveAsFile: !settings.saveAsFile }));

load();
