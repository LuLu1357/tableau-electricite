import Foundation
import SwiftUI
import WebKit

/// URL par défaut du serveur local du Tableau.
/// Doit correspondre au port lancé par `node server/mcp-server.js`
/// (variable d'environnement TABLEAU_PORT, 5858 par défaut).
private let tableauURL = URL(string: "http://127.0.0.1:5858")!

struct ContentView: View {
    @State private var serverReachable: Bool? = nil
    @State private var reloadToken = UUID()

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            Divider()
            ZStack {
                if serverReachable == false {
                    offlineView
                } else {
                    WebView(url: tableauURL, reloadToken: reloadToken)
                }
            }
        }
        .onAppear(perform: checkServer)
    }

    private var toolbar: some View {
        HStack {
            Label("Le Tableau", systemImage: "bolt.fill")
                .font(.headline)
            Spacer()
            statusBadge
            Button {
                checkServer()
                reloadToken = UUID()
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .help("Recharger")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }

    private var statusBadge: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(serverReachable == true ? Color.green : (serverReachable == false ? Color.red : Color.gray))
                .frame(width: 8, height: 8)
            Text(serverReachable == true ? "Serveur connecté" : (serverReachable == false ? "Serveur introuvable" : "Vérification…"))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var offlineView: some View {
        VStack(spacing: 14) {
            Image(systemName: "bolt.slash")
                .font(.system(size: 40))
                .foregroundStyle(.secondary)
            Text("Impossible de joindre le serveur du Tableau")
                .font(.title3.bold())
            Text("Lance-le dans un terminal, depuis le dossier du projet :")
                .foregroundStyle(.secondary)
            Text("node server/mcp-server.js")
                .font(.system(.body, design: .monospaced))
                .padding(8)
                .background(.black.opacity(0.06))
                .cornerRadius(6)
            Button("Réessayer") {
                checkServer()
                reloadToken = UUID()
            }
            .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: 420)
        .padding()
    }

    private func checkServer() {
        var request = URLRequest(url: tableauURL.appendingPathComponent("api/health"))
        request.timeoutInterval = 2
        URLSession.shared.dataTask(with: request) { _, response, error in
            DispatchQueue.main.async {
                if let http = response as? HTTPURLResponse, http.statusCode == 200, error == nil {
                    serverReachable = true
                } else {
                    serverReachable = false
                }
            }
        }.resume()
    }
}

/// Wrapper NSViewRepresentable minimal autour de WKWebView.
struct WebView: NSViewRepresentable {
    let url: URL
    let reloadToken: UUID

    func makeNSView(context: Context) -> WKWebView {
        let webView = WKWebView(frame: .zero)
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        // Recharge la page quand reloadToken change (bouton "Recharger").
        if webView.url == nil || context.coordinator.lastToken != reloadToken {
            context.coordinator.lastToken = reloadToken
            webView.load(URLRequest(url: url))
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    final class Coordinator {
        var lastToken: UUID?
    }
}
