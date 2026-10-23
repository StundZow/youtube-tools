# Notes techniques

Les choix qui ne tiennent pas dans le README, et surtout **pourquoi** ils ont été faits. La plupart viennent d'un bug constaté sur une vraie page : c'est noté à chaque fois, parce que c'est ce qui empêche de les défaire par mégarde.

## Pourquoi l'ancienne version de PrevYou ne marchait plus

- **Manifest V2** : Chrome a désactivé les extensions MV2 courant 2024-2025.
- **Classes CSS renommées** : YouTube est passé des noms en kebab-case (`.yt-core-attributed-string`, `.yt-lockup-metadata-view-model__title`) à du camelCase (`ytAttributedStringHost`, `ytLockupMetadataViewModelTitle`). Tout code qui ciblait les anciens noms ne trouve plus rien.

C'est la leçon de départ : **ne jamais dépendre d'un nom de classe de YouTube.**

## L'aperçu de miniature ne pose pas de HTML figé

Il **clone une vraie carte** déjà présente sur la page, puis remplace son contenu : images, titre, chaîne, vues, durée. Le style, la taille et la grille restent donc ceux du layout courant, quoi que YouTube change.

Sécurités complémentaires :

- deux jeux de sélecteurs (anciens noms kebab-case et nouveaux camelCase) ;
- le texte est écrit dans le nœud feuille le plus « textuel », pas via un chemin DOM rigide ;
- repli `canvas` si une CSP venait à bloquer les images `data:` ;
- clics et survols neutralisés sur la fausse carte : aucune lecture ni navigation déclenchée ;
- la fausse carte est exclue de l'export CSV des vidéos de la page.

## Lire par le sens, pas par le nom

Aucun champ n'est repéré par sa classe. Un fragment « 379 k vues » est reconnu comme des vues, « il y a 1 mois » comme une date, « 1.4x » comme un multiplicateur. C'est ce qui permet de lire le multiplicateur de **vidIQ**, dont les classes sont hachées et changent à chaque version.

Points mis au jour en faisant tourner l'extracteur sur de vraies pages :

- au-delà du million, le français intercale un « de » : **« 1,2 M de vues »** ;
- les cartes compactes affichent le compte **sans le mot** : « 1 M », « 272 k » ;
- les cartes s'emboîtent — `ytd-rich-item-renderer` contient un `yt-lockup-view-model` — donc sans déduplication chaque vidéo compte double ;
- le sous-titre d'un Short agrège plusieurs informations (« 11 k vues · 6 hours ago ») et doit être découpé **avant** d'être classé, et les morceaux doivent *remplacer* le composite, pas le suivre ;
- le premier badge d'un Short est « Nouveau », pas une durée ;
- une playlist se reconnaît à sa pile de miniatures, sinon elle ressort comme une vidéo sans vues ni durée.

### Le piège des sélecteurs multiples

`document.querySelector('a, b, c')` renvoie le premier élément dans l'ordre **du document**, pas dans l'ordre des sélecteurs. La liste `'ytd-watch-info-text, #info-container, #info'` tombait sur un autre `#info` de la page, et les colonnes vues et date ressortaient vides. Les conteneurs sont donc essayés **un par un**.

## La transcription

### Le texte

À côté du timecode visible, YouTube place sa version parlée pour les lecteurs d'écran. Prendre le `textContent` de la ligne collait ce libellé au sous-titre : « 1 minute et 2 secondes**Every job is still random** ». Le texte est donc assemblé feuille par feuille, en écartant celles dont la durée parlée vaut **exactement** le début du segment — ce test d'égalité laisse intact un sous-titre qui commencerait par « 3 minutes plus tard ».

### La date

`date_iso` est toujours absolue. Trois sources, dans l'ordre, **toutes lues dans la page** :

1. les **microdonnées schema.org** (`meta[itemprop="datePublished"]`), exactes. Après une navigation interne ce bloc peut rester celui de la vidéo précédente : on ne s'en sert que si une de ses URL porte l'identifiant courant ;
2. la date affichée si elle est déjà absolue, convertie ;
3. sinon la date relative soustraite d'aujourd'hui. Approximatif, mais figé.

Les microdonnées donnent aussi les **comptes exacts** de vues et de likes. Le piège était l'ordre de priorité : le texte affiché passait devant, donc « 3,5 M de vues » donnait 3 500 000 arrondi alors que le compte exact était disponible juste à côté.

### Aucune requête

Un repli interrogeait `/youtubei/v1/get_transcript`. Il a été retiré : mieux vaut perdre un filet de sécurité que de ressembler à du trafic automatisé. L'extension clique sur « Afficher la transcription » comme un humain, laisse YouTube faire sa propre requête, et lit le résultat.

### Panneaux à ne pas confondre

Les chapitres et les commentaires contiennent eux aussi des timecodes : ils sont explicitement écartés du repérage du panneau de transcription.

## Cohabiter avec d'autres extensions

Plusieurs boutons d'une page de lecture parlent de transcription et ne font pas la même chose. Better YouTube Studio ajoute son propre **« Copier la transcription »** à côté du **« Afficher la transcription »** de YouTube — et il ouvre un menu déroulant, pas le panneau.

Les deux libellés contiennent « transcri » : c'est le **verbe** qui les sépare. Un bouton qui dit « copier », « télécharger » ou « enregistrer » n'est jamais cliqué ; « afficher », « voir » ou « show » est préféré, de même qu'un vrai composant YouTube (`yt-button-shape`) face à un bouton injecté. Si le meilleur candidat n'ouvre rien, le suivant est essayé.

Même principe pour le **placement du panneau de classement** : il s'insère juste avant le bloc de suggestions de YouTube. Viser un élément de YouTube et non les panneaux des autres extensions compte, parce que vidIQ pose ses badges (VPH, multiplicateur) **à l'intérieur** des cartes suggérées — un ancrage cherchant « le dernier bloc contenant du vidIQ » désignait donc la liste entière, et le panneau finissait après toutes les suggestions, invisible en bas de colonne.

## Garder un bouton posé

YouTube reconstruit ses rangées en permanence, et un bouton injecté part avec elles. Les boutons partagent donc un même mécanisme (`keepMounted` dans `common.js`), avec deux garde-fous qui bouchent chacun le trou de l'autre :

- un **throttle à bord de fuite** : les mutations sont regroupées, mais la dernière n'est jamais perdue. Une version antérieure ignorait toute mutation survenue dans les 600 ms suivant une vérification aboutie — si YouTube reconstruisait la rangée pile dans cette fenêtre et que la page se taisait ensuite, aucune vérification ne se relançait et le bouton restait absent jusqu'à la navigation suivante ;
- une **relance espacée** tant que le bouton est attendu mais absent, pour ne dépendre d'aucune mutation future.

Le bouton de transcription s'insère par ailleurs en remontant du bloc J'aime jusqu'à l'enfant direct de la rangée : exiger que le bloc soit lui-même enfant direct le faisait partir en fin de rangée, hors du cadre du lecteur, dès que YouTube l'imbriquait d'un cran.

## Suivre le thème

Les jetons `--yt-spec-*` de YouTube ne sont **pas toujours définis**. Les boutons s'appuyaient dessus avec des couleurs de repli écrites pour le thème clair : en thème sombre, ils devenaient noirs sur fond noir.

Le thème est désormais **mesuré**, pas deviné : on remonte depuis le bouton jusqu'au premier ancêtre au fond opaque et on calcule sa luminance perceptuelle. Si tout est transparent, on retombe sur l'attribut `dark` de YouTube, puis sur celui du système. Mesurer plutôt que lire un indice, parce qu'un attribut peut être renommé alors qu'un fond reste un fond.

## Le classement sur 10

### Le modèle

Une vidéo est comparée aux 9 que sa chaîne a publiées juste avant. Les plus anciennes ayant eu plus de temps, on estime combien de vues chacune avait **au même âge**, avec une courbe de croissance (fonction de Hill) : `x = (h/24)^0,9`, `part = x / (x + 2^0,9)` — soit la moitié des vues en deux jours.

Les Shorts n'ont pas de date dans la liste d'une chaîne : ils sont comparés sur leurs vues actuelles. Avant 24 h, aucun classement, l'estimation serait trop instable.

Paramètres repris de **Better YouTube Studio** (SQUIDUU) pour obtenir les mêmes rangs.

### L'exception réseau

La liste des vidéos d'une chaîne n'est pas dans la page : il faut la demander à `/youtubei/v1/browse`. Garde-fous :

- `credentials: 'omit'` — **aucun cookie, aucune session**. Les requêtes ne sont pas attribuables à un compte ;
- uniquement sur `/watch`, et seulement si le réglage est actif ;
- cache de 6 h par chaîne, verrou pour ne pas charger deux fois les mêmes pages ;
- adresse relative, donc **aucune permission supplémentaire**.

Mesuré : la suite de tests complète fait **11 requêtes en 2,3 s**, dont 0 porteuse de cookie. En usage, 1 à 3 requêtes par classement, puis 0 pendant 6 h sur la même chaîne.

Le mode « exact » de SQUIDUU pour sa propre chaîne (`yta_web/get_cards` signé avec le cookie SAPISID) **n'a pas été repris**, parce qu'il faut lire la session Google. Toutes les chaînes passent par l'estimation. **Merci de ne pas réintroduire d'accès à la session ou aux cookies sans en discuter.**

La réserve honnête : `/youtubei/v1/browse` est une API **interne**, non documentée, appelée avec une clé récupérée dans la page. C'est contraire aux conditions d'utilisation de YouTube, indépendamment du volume.

### Le pont

`rank-bridge.js` est la seule partie qui tourne dans le **monde de la page** (`world: "MAIN"`), parce que les données de la vidéo sont rangées dans des propriétés JavaScript de `ytd-watch-flexy`, invisibles depuis le monde isolé. Il ne fait que recopier quelques informations publiques dans un attribut du document. Il n'émet aucune requête et ne lit aucun cookie.

## Le CSV

Champs entre guillemets et échappés (RFC 4180) : les virgules et guillemets du texte ne cassent rien. Le **BOM UTF-8** n'est ajouté que dans le fichier téléchargé, jamais dans le presse-papiers — collé dans un agent IA, il n'aurait servi qu'à polluer la première ligne.

Une page web ne peut déposer que du **texte** dans le presse-papiers, jamais un fichier. Pour joindre un `.csv` quelque part, il faut passer par le téléchargement : c'est la raison d'être du réglage « Enregistrer un fichier », qui vient **en plus** de la copie.
