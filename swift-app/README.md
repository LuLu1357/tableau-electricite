# Le Tableau — app macOS (SwiftUI)

Petite app macOS native qui affiche le Tableau (servi en local par
`server/mcp-server.js`) dans une fenêtre, sans avoir besoin d'un
navigateur. Toute la logique (dessin, équations, MCP, Codex) reste dans
le serveur Node — cette app n'est qu'une fenêtre native par-dessus.

Il s'agit d'un Swift Package (pas d'un `.xcodeproj` classique) : c'est
le format le plus fiable à générer et à ouvrir tel quel, Xcode l'ouvre
nativement.

## Lancer l'app

**Option A — en ligne de commande** (nécessite les outils de ligne de
commande Xcode : `xcode-select --install`) :

```bash
# 1. démarre le serveur du tableau (dans le dossier racine du projet)
cd ../..
node server/mcp-server.js &

# 2. lance l'app macOS
cd swift-app
swift run
```

**Option B — via Xcode** :

1. Ouvre `swift-app/Package.swift` avec Xcode (double-clic, ou
   `File > Open`).
2. Attends la résolution du package, puis clique sur ▶️ (Run).
3. Assure-toi que le serveur (`node server/mcp-server.js`) tourne déjà
   dans un terminal — l'app affiche un message clair si elle ne le
   trouve pas, avec un bouton « Réessayer ».

## Pourquoi un Swift Package et pas un .xcodeproj ?

Un `.xcodeproj` généré à la main (hors Xcode) est un format binaire/XML
fragile et se corrompt facilement. Un `Package.swift` est du texte
simple, garanti valide, et Xcode le traite comme un projet à part
entière (même icône ▶️ Run, même débogueur). C'est l'approche
recommandée par Apple pour les petits projets.

## Notes techniques

- La fenêtre charge `http://127.0.0.1:5858` dans un `WKWebView`.
  macOS autorise nativement le HTTP non chiffré vers `localhost` et les
  adresses de boucle locale (exception intégrée à l'App Transport
  Security) — aucune configuration `Info.plist` supplémentaire n'est
  nécessaire.
- Si le port du serveur a été changé via la variable d'environnement
  `TABLEAU_PORT`, modifie la constante `tableauURL` dans
  `Sources/TableauElectricite/ContentView.swift`.
- Cible macOS 13 (Ventura) ou plus récent.
