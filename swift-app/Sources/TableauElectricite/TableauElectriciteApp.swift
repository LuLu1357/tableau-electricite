import SwiftUI

// Point d'entrée de l'application macOS "Le Tableau".
// Cette petite app est juste une fenêtre native qui affiche le tableau
// (une page web servie en local par server/mcp-server.js) — elle ne
// contient aucune logique métier : tout le vrai travail (stockage,
// rendu, connexion à Codex via MCP) est fait par le serveur Node.
@main
struct TableauElectriciteApp: App {
    var body: some Scene {
        WindowGroup("Le Tableau — Cours d'électricité") {
            ContentView()
                .frame(minWidth: 1000, minHeight: 680)
        }
        .windowResizability(.contentSize)
        .defaultSize(width: 1280, height: 820)
    }
}
