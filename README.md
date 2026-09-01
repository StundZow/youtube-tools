<div align="center">

<img src="icon.png" width="96" alt="Icône Thumbnail View">

# Thumbnail View

Juge ta **miniature** et ton **titre** au milieu des vraies vidéos YouTube, et copie la **transcription** de n'importe quelle vidéo en CSV.

Extension **Chrome · Edge · Brave · Opera** · [Installation](#prise-en-main)

</div>

> ### Reprise de PrevYou
>
> Cette extension est une reprise de **PrevYou** de BenjaminCode (design BastiUi), **parce que la version publiée ne fonctionne plus** : Chrome a désactivé les extensions Manifest V2, et YouTube a renommé les classes CSS que l'ancien code ciblait.
>
> Tout a donc été recodé de zéro en Manifest V3, avec une approche pensée pour survivre aux prochaines refontes de YouTube — voir [Pourquoi l'ancienne version ne marchait plus](#pourquoi-lancienne-version-ne-marchait-plus).

## Ce que ça fait

Une miniature ne se juge pas dans un éditeur d'image : elle se juge à 320 px de large, coincée entre deux vidéos concurrentes, dans un feed qu'on parcourt au pouce.

Thumbnail View injecte ta fausse carte — miniature, titre, chaîne, avatar, durée — **directement dans le vrai feed YouTube**, au milieu des vraies vidéos, à la taille réelle et dans le vrai thème. Tu vois ce que verra ton audience, pas une maquette.

Et parce qu'on finit toujours par vouloir donner une vidéo à mâcher à une IA, un second bouton copie la **transcription complète au format CSV**, timecodes compris.

## Pourquoi pas juste ouvrir la miniature en grand ?

Parce que ce n'est jamais comme ça qu'elle sera vue. Ce qui compte, c'est la lisibilité du texte une fois réduit, le contraste face aux miniatures voisines, et la longueur du titre avant que YouTube ne le coupe. Aucun de ces trois points ne se voit hors du feed.

## Fonctionnalités

- 🖼️ **Injection dans le vrai feed** — accueil, abonnements, résultats de recherche, page de chaîne, colonne de suggestions du lecteur
- 🎲 **Position aléatoire** — place ta carte quelque part dans la grille plutôt qu'en première position, là où la comparaison est honnête
- 📝 **Copie de la transcription en CSV** — un bouton à côté du J'aime, timecodes de début et de fin inclus
- 🧬 **Clonage d'une vraie carte** plutôt que du HTML figé — le style et la grille sont toujours ceux du layout courant de YouTube
- 🌗 **Thème clair / sombre** dans le popup
- 📋 **Glisser-déposer ou coller** la miniature et l'avatar, avec les champs mémorisés d'une fois sur l'autre
- 🔒 **Aperçu ponctuel** — rien ne s'affiche tant que tu n'as pas cliqué, et tout disparaît dès que tu navigues

## Prise en main

1. Télécharge ce dépôt (**Code → Download ZIP**) et décompresse-le.
2. Ouvre `chrome://extensions` et active le **Mode développeur** en haut à droite.
3. **Charger l'extension non empaquetée** → sélectionne le dossier `prevyou`.
4. Épingle l'extension dans la barre d'outils.

*(Sur Edge, Brave ou Opera : `edge://extensions`, `brave://extensions`, etc. — la marche à suivre est identique.)*

Ensuite :

1. Clique sur l'icône, renseigne le nom de la chaîne, glisse ou colle ta miniature, saisis le titre.
2. Clique sur l'avatar rond pour la photo de profil de la chaîne.
3. **Aperçu** → l'onglet YouTube passe au premier plan avec ta carte injectée.
4. **Retirer l'aperçu** l'enlève tout de suite ; la flèche circulaire remet les champs à zéro.

L'aperçu est **volontairement éphémère** : il n'apparaît qu'au clic, uniquement sur la page où tu as cliqué, et disparaît dès que tu navigues ou recharges. Tant que tu ne cliques pas, l'extension ne touche à rien — impossible qu'elle remplace une miniature pendant que tu visites d'autres chaînes.

## Copier la transcription (CSV)

Sur chaque page de lecture, un petit bouton **☰** est ajouté juste à droite du bouton J'aime. Un clic copie toute la transcription dans le presse-papiers, prête à être collée dans un agent IA :

```csv
start,end,text
"0:00","0:04","Bonjour à tous et bienvenue"
"0:04","0:09","Aujourd'hui on va parler de..."
```

- `start` / `end` en `m:ss`, ou `h:mm:ss` si la vidéo dépasse une heure
- `end` correspond au début du segment suivant
- champs entre guillemets et échappés (RFC 4180) : les virgules et guillemets du texte ne cassent rien

Le bouton affiche le nombre de lignes copiées, ou « Introuvable » si la vidéo n'a pas de transcription. En cas d'échec, un diagnostic part dans la console (`[PrevYou] transcription introuvable`).

## Pourquoi l'ancienne version ne marchait plus

- **Manifest V2** : Chrome a désactivé les extensions MV2 courant 2024-2025.
- **Classes CSS renommées** : YouTube est passé des noms en kebab-case (`.yt-core-attributed-string`, `.yt-lockup-metadata-view-model__title`) à du camelCase (`ytAttributedStringHost`, `ytLockupMetadataViewModelTitle`). Tout code qui ciblait les anciens noms ne trouve plus rien.

## Comment ça marche

L'extension **n'injecte pas de HTML figé**. Elle clone une vraie carte vidéo déjà présente sur la page, puis remplace uniquement son contenu : images, titre, chaîne, vues, durée. Le style, la taille et la grille restent donc ceux du layout courant.

Sécurités complémentaires :

- deux jeux de sélecteurs (anciens noms kebab-case + nouveaux camelCase) ;
- le texte est écrit dans le nœud feuille le plus « textuel », pas via un chemin DOM rigide ;
- repli `canvas` si une CSP venait à bloquer les images `data:` ;
- MutationObserver throttlé, limité à la page courante, qui repose la carte si YouTube re-rend sa grille et se coupe dès que l'URL change ;
- clics et survols neutralisés sur la fausse carte (aucune lecture ni navigation déclenchée).

**La lecture de la transcription ne dépend d'aucun nom de classe.** Plutôt que de chercher `.segment-timestamp` / `.segment-text` — que YouTube renomme régulièrement — elle repère les nœuds dont le texte *est* un timecode, puis remonte jusqu'au plus grand ancêtre qui n'en contient qu'un seul : c'est la ligne du segment, et le reste de son texte est le sous-titre. Ça survit aux refontes et fonctionne même si une autre extension a redécoré le panneau.

Deux garde-fous notables : les panneaux de chapitres et de commentaires contiennent eux aussi des timecodes et sont explicitement écartés ; et le repli API vérifie que l'identifiant de vidéo encodé dans les paramètres est bien celui de la page courante — sans quoi une navigation interne ferait copier la transcription de la vidéo précédente.

## Structure

```
prevyou/
├── manifest.json    MV3, permissions : storage, scripting, activeTab,
│                    clipboardWrite + youtube.com
├── popup.html/css/js   interface (thème clair/sombre, drag & drop, coller)
├── content.js       clonage + remplissage + réinjection
├── content.css      ajustements sur la carte injectée
├── transcript.js    bouton « copier la transcription » + export CSV
├── transcript.css   style du bouton, aligné sur celui de YouTube
└── icons/           16 / 32 / 48 / 128 px
```

Les images sont redimensionnées (1280 px max, WebP) avant d'être stockées dans `chrome.storage.local`. **Aucune donnée ne sort du navigateur** et l'extension ne fait aucune requête vers un service tiers.

## Crédits

Concept et design d'origine : **PrevYou** par BenjaminCode, design par BastiUi. Cette version est un recodage complet en Manifest V3, l'originale n'étant plus fonctionnelle.
