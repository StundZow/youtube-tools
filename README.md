<div align="center">

<img src="icon.png" width="96" alt="Icône YouTube Tools">

# YouTube Tools

Teste ta miniature, copie une transcription, exporte un feed, situe une vidéo dans sa chaîne — **sans jamais quitter YouTube**.

[**⬇ Installer l'extension**](#prise-en-main) · Chrome · Edge · Brave · Opera

</div>

> **Reprise de PrevYou.** Cette extension part de **PrevYou** de BenjaminCode (design BastiUi), **parce que la version publiée ne fonctionne plus** : Chrome a désactivé les extensions Manifest V2, et YouTube a renommé les classes CSS que l'ancien code ciblait. Tout a été recodé de zéro en MV3.

## Ce que ça fait

YouTube montre une foule de choses qu'il ne laisse pas récupérer : l'effet réel d'une miniature au milieu des autres, le texte d'une vidéo, les chiffres d'un feed, la place d'une vidéo dans l'historique de sa chaîne. Il faut tout relever à la main, ou renoncer.

YouTube Tools ajoute quatre outils directement dans l'interface. Chacun sort une information que tu voyais déjà, dans une forme exploitable : du **CSV** prêt à coller dans un tableur ou un agent IA, et un aperçu de miniature posé **dans le vrai feed**, au milieu des vraies vidéos.

## Pourquoi pas juste ouvrir la miniature en grand ?

Parce que ce n'est jamais comme ça qu'elle sera vue. Ce qui compte, c'est la lisibilité du texte une fois réduit, le contraste face aux miniatures voisines, et la longueur du titre avant que YouTube ne le coupe. Aucun de ces trois points ne se voit hors du feed.

## Fonctionnalités

- 🖼️ **Aperçu de miniature dans le vrai feed** — accueil, abonnements, recherche, page de chaîne, suggestions du lecteur. Une vraie carte est clonée, donc le rendu suit toujours le layout courant de YouTube
- 🎲 **Position aléatoire** — place ta carte quelque part dans la grille plutôt qu'en tête, là où la comparaison est honnête
- 📝 **Transcription en CSV** — un bouton à côté du J'aime, timecodes et métadonnées de la vidéo inclus
- 💾 **Export des vidéos d'une page** — depuis la barre du haut, sur toutes les pages YouTube
- 🏆 **Classement sur 10** — où se situe la vidéo parmi les 10 dernières de sa chaîne, à âge égal
- 🌗 **Thème clair / sombre** — les boutons mesurent le fond de la page et s'y accordent, sans recharger
- ⚙️ **Paramètres** — chaque outil s'active ou se coupe depuis le popup
- 🔒 **Aperçu ponctuel** — rien ne s'affiche tant que tu n'as pas cliqué, et tout disparaît dès que tu navigues

## Prise en main

1. Télécharge ce dépôt (**Code → Download ZIP**) et décompresse-le.
2. Ouvre `chrome://extensions` et active le **Mode développeur** en haut à droite.
3. **Charger l'extension non empaquetée** → sélectionne le dossier `youtube-tools`.
4. Épingle l'extension dans la barre d'outils.

*(Sur Edge, Brave ou Opera : `edge://extensions`, `brave://extensions`, etc. — la marche à suivre est identique.)*

Pour l'aperçu de miniature : clique sur l'icône, renseigne la chaîne, glisse ou colle ta miniature, saisis le titre, puis **Aperçu**. L'onglet YouTube passe au premier plan avec ta carte injectée. **Retirer l'aperçu** l'enlève ; la flèche circulaire remet les champs à zéro.

## Les quatre outils

### Aperçu de miniature

Volontairement **éphémère** : la carte n'apparaît qu'au clic, uniquement sur la page où tu as cliqué, et disparaît dès que tu navigues ou recharges. Tant que tu ne cliques pas, l'extension ne touche à rien.

### Transcription (bouton ☰, à côté du J'aime)

Copie toute la transcription dans le presse-papiers, métadonnées de la vidéo comprises :

```csv
titre,chaine,debut,fin,debut_s,texte,date,date_iso,vues,vues_num,likes,duree,duree_s,url,id
"Ma vidéo","Ma Chaîne","0:00","0:05","0","Première phrase","il y a 3 semaines","2026-08-16","1 659 225 vues","1659225","21816","1:00:44","3644","https://…","lZGoJT4abos"
```

`date_iso` est **toujours** une date absolue : une date relative pourrit, « il y a 9 mois » désignera autre chose dans trois mois. `vues_num` et `likes` reprennent les comptes exacts quand la page les donne. `duree_s` permet de trier et de calculer des densités.

### Export des vidéos d'une page (bouton ⤓, barre du haut)

Copie toutes les vidéos **actuellement chargées** — rien n'est préchargé, donc déroule autant que tu veux avant de cliquer :

```csv
position,titre,chaine,vues,vues_num,date,duree,duree_s,multiplicateur,type,url
"1","KEYBOARD ESCAPE…","Kevko Gaming","149 k vues","149000","il y a 16 heures","18:48","1128","1.4x","video","https://…"
```

`position` donne le rang sur la page. `multiplicateur` reprend le `1.4x` de **vidIQ** si l'extension est installée. `type` vaut `video`, `short` ou `playlist`.

### Classement sur 10 (panneau, colonne de droite)

Place de la vidéo parmi les 10 dernières de sa chaîne, **à âge égal** : les plus anciennes ayant eu plus de temps, on estime combien de vues chacune avait au même âge. Reprise de la fonction du même nom de **Better YouTube Studio** (SQUIDUU), avec le même modèle de calcul.

C'est la **seule** fonction qui interroge YouTube — la liste des vidéos d'une chaîne n'est pas dans la page. Elle le fait **sans aucun cookie**, uniquement sur des données publiques, avec un cache de 6 h, et l'interrupteur du popup la coupe entièrement.

## Paramètres

| Réglage | Effet |
|---|---|
| **Bouton transcription** | affiche ou retire le **☰** à côté du J'aime |
| **Bouton export vidéos** | affiche ou retire le **⤓** en haut de page |
| **Enregistrer un fichier** | télécharge un `.csv` **en plus** de la copie, pour les deux boutons |
| **Classement sur 10** | affiche le panneau — et coupe les seules requêtes de l'extension |

Les changements s'appliquent **immédiatement**, sans recharger l'onglet.

## Vie privée

Les images sont redimensionnées puis gardées dans `chrome.storage.local`, sur ta machine. **Aucune donnée ne sort du navigateur** et l'extension ne contacte aucun service tiers. La seule exception réseau est le classement sur 10, décrit plus haut.

## Lancer les tests

```bash
node youtube-tools/tests/rank-core.test.js
```

Le cœur du classement, contre de vraies chaînes publiques. Environ 11 requêtes, sans cookie.

## Sous le capot

Comment l'extension survit aux refontes de YouTube, pourquoi elle lit les métadonnées par ce qu'elles *disent* plutôt que par leur nom de classe, comment elle cohabite avec vidIQ et Better YouTube Studio : voir **[NOTES-TECHNIQUES.md](NOTES-TECHNIQUES.md)**.

## Structure

```
youtube-tools/
├── manifest.json    MV3 — storage, scripting, activeTab, clipboardWrite
├── popup.html/css/js   interface (thème, drag & drop, paramètres)
├── common.js        réglages, remise CSV, maintien des boutons, thème
├── content.js/css   aperçu de miniature dans le feed
├── transcript.js/css   bouton ☰ et export de la transcription
├── videos.js/css    bouton ⤓ et export des vidéos de la page
├── rank-core.js     calcul du classement (sans DOM, testable sous Node)
├── rank-bridge.js   lecture des données de la vidéo (monde de la page)
├── rank.js/css      panneau de la colonne de droite
├── tests/           tests du cœur de calcul
└── icons/           16 / 32 / 48 / 128 px
```

## Crédits

Concept et design d'origine : **PrevYou** par BenjaminCode, design par BastiUi. Le classement sur 10 reprend le modèle de **Better YouTube Studio** par SQUIDUU. Cette version est un recodage complet en Manifest V3.
