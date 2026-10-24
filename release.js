#!/usr/bin/env node
'use strict';

/**
 * Publie une version de YouTube Tools sur GitHub.
 *
 *   node release.js                  notes reprises du dernier commit
 *   node release.js "Ce qui change"  notes explicites
 *
 * Le numero de version vient de youtube-tools/manifest.json : c'est la seule
 * source de verite, il n'y a donc rien a tenir a jour en double.
 *
 * L'archive porte TOUJOURS le meme nom, `youtube-tools.zip`. C'est ce qui
 * permet au lien du README de pointer vers
 * `releases/latest/download/youtube-tools.zip` sans jamais changer.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RACINE = __dirname;
const DOSSIER = 'youtube-tools';
const ARCHIVE = path.join(RACINE, 'dist', DOSSIER + '.zip');

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: RACINE, encoding: 'utf8', ...opts }).trim();

function echoue(message) {
  console.error('\n  ' + message + '\n');
  process.exit(1);
}

/* ------------------------------------------------------------- verifications */

const manifest = JSON.parse(fs.readFileSync(path.join(RACINE, DOSSIER, 'manifest.json'), 'utf8'));
const version = manifest.version;
const tag = 'v' + version;

if (sh('git', ['status', '--porcelain'])) {
  echoue('Des modifications ne sont pas committees. Committe et pousse avant de publier.');
}
sh('git', ['fetch', '--quiet', 'origin']);
const [retard, avance] = sh('git', ['rev-list', '--left-right', '--count', 'origin/main...HEAD'])
  .split(/\s+/).map(Number);
if (avance) echoue(avance + ' commit(s) non pousse(s). Fais `git push` avant de publier.');
if (retard) echoue(retard + ' commit(s) de retard sur origin. Fais `git pull` avant de publier.');

/* ------------------------------------------------------------------ archive */

fs.mkdirSync(path.dirname(ARCHIVE), { recursive: true });
fs.rmSync(ARCHIVE, { force: true });

// Compress-Archive garde le dossier dans l'archive : la decompression donne
// bien un dossier `youtube-tools` a charger tel quel dans Chrome.
sh('powershell', ['-NoProfile', '-Command',
  `Compress-Archive -Path '${DOSSIER}' -DestinationPath '${ARCHIVE.replace(/'/g, "''")}' -Force`]);

const poids = (fs.statSync(ARCHIVE).size / 1024).toFixed(0);
console.log(`archive : dist/${DOSSIER}.zip  (${poids} Ko)`);

/* ------------------------------------------------------------------ release */

const notes = process.argv[2] || sh('git', ['log', '-1', '--pretty=%s']);

let existe = true;
try { sh('gh', ['release', 'view', tag], { stdio: 'pipe' }); } catch { existe = false; }

if (existe) {
  sh('gh', ['release', 'upload', tag, ARCHIVE, '--clobber']);
  sh('gh', ['release', 'edit', tag, '--notes', notes]);
  console.log(`release ${tag} mise a jour`);
} else {
  sh('gh', ['release', 'create', tag, ARCHIVE,
    '--title', `YouTube Tools ${version}`, '--notes', notes]);
  console.log(`release ${tag} creee`);
}

console.log('telechargement : https://github.com/StundZow/youtube-tools/releases/latest/download/'
  + DOSSIER + '.zip');
