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

## Dictée scientifique locale (prototype)

La boucle normale de dictée est entièrement locale : le navigateur capture le
micro, `whisper.cpp` transcrit, puis Qwen3 1.7B met la dictée en texte ou LaTeX.
Codex et l’API OpenAI ne participent pas à cette boucle. Les aperçus restent
transitoires ; seul le résultat final entre dans le store, avec
`source: "eleve"`, en une mutation groupée.

Installation sur Apple Silicon :

```bash
brew install whisper-cpp ollama
mkdir -p models
curl -L https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin \
  -o models/ggml-base.bin
brew services start ollama
ollama pull qwen3:1.7b
```

Lance ensuite Le Tableau comme d’habitude :

```bash
npm start
```

Dans `http://127.0.0.1:5858` :

1. avec l’outil de sélection, clique dans une zone vide pour placer le petit
   repère d’insertion ;
2. clique sur **🎙️ Dicter** (ou `⌥ Espace`) et parle ;
3. l’aperçu s’affiche pendant la parole ; clique sur **Arrêter** pour mettre au
   propre et insérer ;
4. la position descend automatiquement pour la phrase ou dictée suivante.

Le serveur conserve dans chaque élément dicté la transcription brute, les
segments temporels retournés par Whisper, le moteur d’interprétation, la raison
du routage, le parse structuré et une éventuelle description d’ambiguïté. Qwen
reçoit seulement un petit contexte structuré (sélection et éléments proches),
jamais une capture permanente du tableau. Pour la latence et la fidélité, les
formes élémentaires reconnues sont traitées d’abord par un parseur littéral ;
Qwen intervient seulement pour les formulations non couvertes. Les règles ne
sont acceptées que si l'AST est
valide et si tous les tokens significatifs ont été consommés. Si Ollama n’est
pas joignable, une phrase mathématique incomplètement comprise est conservée
comme texte ambigu au lieu de produire silencieusement un mauvais LaTeX. Le
parseur ne corrige jamais la physique.

Variables optionnelles :

- `WHISPER_CPP_BIN` : chemin de `whisper-cli` ;
- `WHISPER_MODEL` : chemin d’un modèle GGML différent ;
- `TABLEAU_WHISPER_PROMPT` : contexte Whisper court à tester explicitement ;
- `TABLEAU_WHISPER_USE_CONTEXT=1` : active le contexte scientifique proposé et
  y ajoute au plus 12 symboles pertinents du tableau (désactivé par défaut tant
  que le corpus réel n'a pas démontré un gain) ;
- `TABLEAU_LOCAL_MODEL` : modèle Ollama (défaut `qwen3:1.7b`) ;
- `TABLEAU_DICTATION_PREVIEW_MS` : cadence minimale des aperçus (défaut 1400
  ms).

Diagnostic local : `GET /api/dictation/status` indique quel moteur est prêt.
`GET /api/dictation/diagnostics` retourne les 50 dernières dictées en mémoire :
durée audio, transcription et segments Whisper, modèle/prompt, interpréteur et
raison de sélection, AST/échec de parse, sortie finale et latences. Cet endpoint
local n'ajoute rien à l'interface et ne conserve pas l'audio.

### Apple Speech dans l’app macOS

Sur macOS 26 ou plus récent, l’app Swift propose aussi **Apple Speech** dans le
menu **Moteur local**. Cette voie utilise `SpeechAnalyzer` avec
`SpeechTranscriber` en français, ses résultats volatils pour l’aperçu en direct,
et son résultat final après l’arrêt. La reconnaissance est effectuée sur
l’appareil. Le flux PCM déjà capturé par la page est simplement transmis à
l’app Swift par le pont WKWebView : la capture navigateur, Whisper et le parseur
mathématique existants restent en place.

Le contexte Apple contient notamment Pythagore, Kirchhoff, Thévenin, Norton,
Ohm, VC, VR, VS, VL, R1 et R2. Le moteur renvoie ensuite sa transcription au
même `scientific-interpreter` / `spoken-math-parser`. Les éléments conservent
donc `source: eleve`, la transcription brute, les segments, l’ambiguïté, le
moteur d’interprétation, la raison de routage et le parse structuré. Le champ
`dictation.engine` vaut `apple-speech` ou `whisper`.

Les diagnostics communs exposent maintenant `engine`, `transcription.transcript`,
`transcription.model`, `transcription.segments`, le vocabulaire contextuel, la
latence de la passe finale et le pic mémoire. Pour Apple Speech, la mémoire est
la mémoire résidente maximale observée pour l’app pendant la dictée (avec une
valeur de départ) ; pour Whisper, elle vient de la mesure du processus
`whisper-cli`. L’interface affiche après chaque essai le premier texte, la
finalisation après l’arrêt et la mémoire.

#### Comparer Apple Speech et Whisper sur les mêmes phrases

1. Lance le serveur puis l’app avec `cd swift-app && swift run`.
2. Choisis **Apple Speech**, dicte la phrase, arrête, puis note le texte final et
   les trois mesures affichées.
3. Choisis **Whisper** et redis exactement la même phrase, à distance et débit
   comparables. Alterne l’ordre des moteurs à chaque répétition pour limiter
   l’effet d’échauffement.
4. Fais au moins trois répétitions par moteur et consulte le détail dans
   `http://127.0.0.1:5858/api/dictation/diagnostics`.
5. Compare la transcription brute avant de comparer le LaTeX final : les deux
   moteurs partagent volontairement le même interpréteur.

Mini-corpus conseillé :

- « Pythagore : a au carré plus b au carré égale c au carré » ;
- « La loi de Kirchhoff donne VS égale VR plus VC » ;
- « VC égale un sur C fois intégrale de i par rapport au temps » ;
- « Thévenin donne VTH égale dix volts et RTH égale deux kilo-ohms » ;
- « Z égale R plus j ouvre parenthèse oméga L moins un sur oméga C ferme
  parenthèse ».

Cette comparaison utilise les mêmes formulations, mais deux prises de voix
distinctes. Pour une comparaison ASR strictement identique au niveau audio, le
benchmark WAV existant reste la référence côté Whisper ; l’entrée fichier
Apple n’est pas incluse dans cette version minimale.

### Corpus vocal réel et benchmark

Pour commencer un corpus privé, lance le serveur avec
`TABLEAU_DICTATION_CAPTURE=1`. Chaque dictée ajoute dans le dossier Git-ignoré
`data/dictation-corpus/` un WAV et une entrée de `manifest.json`. Complète pour
chaque entrée `expectedTranscript` (ce qui a réellement été dit) et
`expectedOutput` (LaTeX/texte voulu). `correctedOutput` peut conserver une
correction ultérieure de Lucas. Aucun audio n'est capturé sur disque sans cette
option et le dossier `data/` n'est pas versionné.

Quand au moins 50 exemples réels sont complétés, lance :

```bash
npm run benchmark:dictation
```

Le banc utilise exactement les mêmes audios pour Base et Small, avec et sans
contexte. Il écrit localement un rapport détaillé avec WER ASR, exactitude de
l'interpréteur sur la transcription attendue, exactitude de bout en bout,
latence et pic mémoire. Les chemins peuvent être changés avec
`WHISPER_BASE_MODEL` et `WHISPER_SMALL_MODEL`. Le temps du premier aperçu est
mesuré lors des vraies sessions et visible dans l'endpoint diagnostic.

Les tests scientifiques et toutes les non-régressions restent réunis dans
`npm test`. Sur macOS, `npm run test:dictation:local` génère une piste parlée
française et valide uniquement la chaîne audio complète sans toucher au vrai
tableau. Ce test synthétique n'est jamais compté comme une mesure de qualité
ASR.

### Mesures techniques disponibles (M2, 8 Go)

Contrôle synthétique réalisé le 13 août 2026 avec une phrase de 1,93 s. Il
mesure la latence et la mémoire de cette installation, pas la qualité sur la
voix de Lucas :

| Étape | Latence observée | Mémoire maximale observée |
|---|---:|---:|
| Whisper `base`, CPU/Accelerate, sans prompt | 11,60 s | 320 Mo |
| Whisper `base`, CPU/Accelerate, prompt scientifique | 11,79 s | 480 Mo |
| Chaîne locale complète, aperçu réutilisé après arrêt | 0,01 s après arrêt | — |

Le premier aperçu observé était de 12,34 s. Le prompt a transformé « plus » en
« + » sur cette voix synthétique (désormais accepté par le parseur), sans gain
de latence et avec davantage de mémoire ; il reste donc désactivé par défaut.
Seul `ggml-base.bin` est actuellement installé. Il n'existe encore aucun audio
réel de Lucas dans le corpus : aucune conclusion honnête Base contre Small, ni
sur les traitements micro/rééchantillonnage, ne peut être donnée avant la
collecte. L'architecture actuelle (traitements navigateur activés et moyenne
par fenêtres vers 16 kHz) reste volontairement inchangée en attendant ce même
benchmark. Cette installation fournit aussi `whisper-server` et
`whisper-stream` : garder le modèle chargé est donc techniquement possible,
mais n'est pas intégré avant une mesure comparative sur le corpus réel afin de
ne pas transformer cette phase en réécriture du pipeline.

## Remerciements / bibliothèques utilisées

Ce projet est un développement original, construit avec les
bibliothèques open source suivantes :

- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) — implémentation officielle du protocole MCP.
- [KaTeX](https://katex.org/) — rendu des équations LaTeX, aussi bien dans le navigateur que côté serveur.
- [sharp](https://sharp.pixelplumbing.com/) — rasterisation SVG → PNG pour que Codex puisse « voir » le tableau.
- [Express](https://expressjs.com/) et [ws](https://github.com/websockets/ws) — serveur HTTP et WebSocket.

Les symboles de circuits (pile, résistance, etc.) suivent la
convention IEC/CEI utilisée dans l'enseignement en Belgique/France.
