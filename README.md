# Le Tableau — cours d'électricité avec Codex

Un tableau blanc partagé entre toi et **Codex**, pour faire de
l'électricité ensemble : Codex peut voir ce que tu dessines/écris, et
peut lui-même écrire des équations, tracer des schémas de circuits
(pile, résistance, LED, condensateur, interrupteur…), annoter, et
effacer — directement sur le même tableau que toi.

**Zéro clé API, zéro facturation à l'usage.** Codex se connecte à ce
tableau via un serveur **MCP** local (protocole stdio) — pas d'appel
réseau vers l'API OpenAI facturée à l'usage. Tout ce qu'il te faut,
c'est ton abonnement **ChatGPT Plus** (ou Pro) et l'app/CLI **Codex**
déjà connectée à ce compte.

<p align="center"><em>Toi et Codex, sur le même tableau — comme avec un prof particulier.</em></p>

## Ce que c'est concrètement

- Un petit **serveur Node local** (`server/mcp-server.js`) qui fait
  deux choses en même temps :
  1. il sert une page web (`web/index.html`) — le tableau, ouvrable
     dans ton navigateur ou dans l'app macOS fournie ;
  2. il expose un **serveur MCP** que Codex peut piloter avec 10
     outils en français (écrire une équation, dessiner un composant,
     tracer un fil, voir le tableau avec une image, etc.).
- Le tableau et Codex voient **exactement le même état** en temps réel
  (WebSocket) : ce que tu dessines apparaît immédiatement pour Codex
  (qui peut « regarder » le tableau, y compris visuellement via une
  image PNG), et ce que Codex dessine apparaît immédiatement chez toi.
- Une **app macOS** optionnelle (SwiftUI) pour avoir le tableau dans
  une fenêtre native plutôt que dans le navigateur.

## Installation (une seule fois)

Prérequis : [Node.js](https://nodejs.org) 18 ou plus récent, et la
CLI [Codex](https://developers.openai.com/codex/) connectée à ton
compte ChatGPT Plus (`codex login`).

```bash
cd tableau-electricite
npm install
```

## Connecter Codex au tableau (une seule fois)

Dans un terminal, à la racine du projet :

```bash
codex mcp add tableau-electricite -- node "$(pwd)/server/mcp-server.js"
```

Cette commande enregistre le tableau comme serveur MCP pour Codex.
Codex le démarrera lui-même (en tant que sous-processus, via stdio)
dès que tu lances une session — tu n'as **rien d'autre à lancer à la
main** pour la partie Codex.

Vérifie que Codex le voit bien :

```bash
codex mcp list
```

## Utiliser le tableau

1. Lance une session Codex normalement, dans le dossier de ton choix :
   ```bash
   codex
   ```
   (ou ouvre l'app Codex desktop, si tu préfères le mode vocal — voir
   plus bas.)
2. Ouvre ton navigateur sur **[http://127.0.0.1:5858](http://127.0.0.1:5858)**
   — c'est ton tableau. La première fois que Codex utilise un de ses
   outils, le serveur démarre automatiquement (pas besoin de le lancer
   toi-même : Codex le fait en te connectant au MCP).
3. Discute avec Codex, par exemple :
   - « Regarde le tableau et corrige mon schéma si le sens du courant
     est faux. »
   - « Dessine-moi un circuit avec une pile 9V, une résistance de
     220 Ω et une LED, en série. »
   - « Écris l'équation de la loi d'Ohm sur le tableau, à côté de mon
     schéma. »
   - « J'ai écrit un calcul de résistance équivalente en bas du
     tableau, dis-moi si c'est juste. »
4. Dessine, écris du texte, place des composants, trace des fils
   toi-même avec les outils de la barre latérale — Codex les voit en
   direct.

Astuce : le bouton **ℹ️ Connecter Codex** dans le tableau réaffiche à
tout moment la commande `codex mcp add …` avec le bon chemin.

## Les 10 outils que Codex peut utiliser

| Outil | Ce qu'il fait |
|---|---|
| `voir_tableau` | Renvoie la liste des éléments **et** une image PNG du tableau (Codex « voit » vraiment le dessin) |
| `lister_elements` | Renvoie juste la liste des éléments (plus léger, sans image) |
| `ecrire_equation` | Ajoute une équation (LaTeX) à une position donnée |
| `ecrire_texte` | Ajoute un texte libre |
| `dessiner_composant` | Place un composant électrique (pile, résistance, condensateur, interrupteur, masse, LED, bobine, ampèremètre, voltmètre, lampe, diode) |
| `tracer_fil` | Trace un fil (une ou plusieurs lignes brisées) entre des points |
| `dessiner_forme` | Trace une forme générique (ligne, flèche, rectangle, ellipse) |
| `modifier_element` | Modifie un élément existant (position, couleur, texte…) |
| `supprimer_element` | Supprime un élément précis |
| `effacer_tableau` | Efface tout le tableau, ou seulement un type d'élément |

## Maîtriser la consommation (mode vocal, modèle utilisé)

Les appels aux outils MCP ci-dessus ne coûtent **rien en tokens
d'API** — c'est local. Ce qui consomme, c'est la conversation elle-même
avec Codex (texte ou voix). Deux leviers si tu veux réduire la
consommation en mode vocal :

- **Choisir un modèle plus léger** dans Codex CLI :
  ```bash
  codex --model gpt-5.6-luna
  # ou, en session : /model gpt-5.6-luna
  ```
  (`luna` est le modèle le plus économique de la famille GPT‑5.6,
  `terra` un compromis, `sol` le plus complet.)
- **Limiter le mode vocal à de la transcription** plutôt qu'à de
  l'audio conversationnel complet, dans `~/.codex/config.toml` :
  ```toml
  [features]
  voice_transcription = true

  [realtime]
  type = "transcription"
  ```
  (`type = "conversational"` active le mode voix-à-voix temps réel,
  plus riche mais plus gourmand.)

## App macOS (optionnel)

Un petit wrapper SwiftUI qui affiche le tableau dans une fenêtre
native au lieu du navigateur. Voir [`swift-app/README.md`](swift-app/README.md).

## Structure du projet

```
tableau-electricite/
├── server/
│   ├── mcp-server.js   # point d'entrée : sert le web + le MCP
│   ├── http.js         # serveur HTTP + WebSocket
│   ├── store.js        # état du tableau, persisté dans data/tableau.json
│   └── snapshot.js      # rendu du tableau en image PNG (pour Codex)
├── web/
│   ├── index.html, style.css, app.js   # l'interface du tableau
│   ├── render.js        # rendu SVG partagé (composants, équations…)
│   └── vendor/katex/    # KaTeX embarqué (rendu LaTeX hors-ligne)
├── swift-app/            # app macOS (SwiftUI) optionnelle
├── test/                 # test de bout en bout du serveur MCP
└── data/                 # état persisté (créé automatiquement)
```

## Améliorer le projet toi-même

Tu peux modifier le tableau sans passer par Codex. Les trois fichiers les plus
utiles sont :

- `web/app.js` : interactions du tableau (outils, sélection, déplacement,
  WebSocket).
- `web/render.js` : apparence des composants et des équations SVG.
- `web/style.css` : mise en page, dimensions du tableau et styles.

Pour travailler localement :

```bash
cd /Users/lucassimonnet/Documents/Electronics/tableau-electricite
npm install
npm start
```

Ouvre ensuite `http://127.0.0.1:5858` dans ton navigateur. Après une
modification de `web/`, rafraîchis simplement la page. Les données présentes
sur le tableau sont sauvegardées dans `data/tableau.json` : fais une capture
ou une copie de ce fichier avant une modification importante.

### Sélection multiple

Avec l’outil de sélection :

- glisse depuis une zone vide pour tracer un cadre ;
- les éléments touchés ou contenus dans ce cadre sont sélectionnés ;
- glisse l’un des éléments sélectionnés pour déplacer tout le groupe ;
- la touche Suppr efface la sélection entière.

Cette logique se trouve dans `web/app.js`. Les tests associés sont dans
`test/browser-selection.js`.

### Skill Codex du tableau

Le comportement pédagogique de Codex pour ce projet est défini dans le skill
personnel suivant :

```text
/Users/lucassimonnet/.codex/skills/ouvrir-le-tableau/SKILL.md
```

Il indique à Codex comment ouvrir le tableau, écrire les équations, ne pas
effacer le travail sans accord, et vérifier un rendu complet du tableau quand
un élément semble invisible ou coupé. Le serveur MCP utilisé par ce skill est
`server/mcp-server.js`.

Pour conserver une référence directement dans le dépôt, le guide du skill est
copié dans [`documentation/SKILL-OUVRIR-LE-TABLEAU.txt`](documentation/SKILL-OUVRIR-LE-TABLEAU.txt)
et la configuration du serveur MCP dans
[`documentation/MCP-TABLEAU-ELECTRICITE.txt`](documentation/MCP-TABLEAU-ELECTRICITE.txt).

### Vérifier tes modifications

```bash
npm test
```

La commande vérifie le serveur MCP et les scénarios de sélection dans le
navigateur. Si un affichage paraît absent, vérifie d’abord que l’élément est
bien présent dans `data/tableau.json`, puis recharge la page ; le fichier
`server/snapshot.js` permet aussi de produire un rendu complet du tableau.

## Remerciements / bibliothèques utilisées

Ce projet est un développement original, construit avec les
bibliothèques open source suivantes :

- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) — implémentation officielle du protocole MCP.
- [KaTeX](https://katex.org/) — rendu des équations LaTeX, aussi bien dans le navigateur que côté serveur.
- [sharp](https://sharp.pixelplumbing.com/) — rasterisation SVG → PNG pour que Codex puisse « voir » le tableau.
- [Express](https://expressjs.com/) et [ws](https://github.com/websockets/ws) — serveur HTTP et WebSocket.

Les symboles de circuits (pile, résistance, etc.) suivent la
convention IEC/CEI utilisée dans l'enseignement en Belgique/France.
