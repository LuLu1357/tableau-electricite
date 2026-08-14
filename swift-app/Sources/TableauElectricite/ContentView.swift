import Foundation
import SwiftUI
import WebKit

/// URL par défaut du serveur local du Tableau.
/// Utilise la variable d'environnement TABLEAU_PORT si fournie, sinon 5859.
private let tableauPort = Int(ProcessInfo.processInfo.environment["TABLEAU_PORT"] ?? "5859") ?? 5859
private let tableauURL = URL(string: "http://127.0.0.1:\(tableauPort)")!

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
        let configuration = WKWebViewConfiguration()
        let appleSpeechAvailable: Bool
        if #available(macOS 26.0, *) { appleSpeechAvailable = true } else { appleSpeechAvailable = false }
        configuration.userContentController.addUserScript(WKUserScript(
            source: "window.tableauAppleSpeechAvailable = \(appleSpeechAvailable ? "true" : "false");",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        configuration.userContentController.add(context.coordinator, name: "appleSpeech")
        let webView = WKWebView(frame: .zero, configuration: configuration)
        context.coordinator.webView = webView
        webView.uiDelegate = context.coordinator
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

    @MainActor
    final class Coordinator: NSObject, WKUIDelegate, WKScriptMessageHandler {
        var lastToken: UUID?
        weak var webView: WKWebView?
        private lazy var appleSpeech = AppleSpeechController { [weak self] event in
            self?.sendToPage(event)
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "appleSpeech",
                  message.frameInfo.securityOrigin.protocol == "http",
                  message.frameInfo.securityOrigin.host == "127.0.0.1",
                  message.frameInfo.securityOrigin.port == tableauPort,
                  let body = message.body as? [String: Any],
                  let action = body["action"] as? String else { return }

            switch action {
            case "start":
                appleSpeech.start(contextualStrings: body["contextualStrings"] as? [String] ?? [])
            case "audio":
                guard let encoded = body["pcm"] as? String, let data = Data(base64Encoded: encoded) else { return }
                appleSpeech.append(data)
            case "stop":
                appleSpeech.stop()
            case "cancel":
                appleSpeech.cancel()
            default:
                break
            }
        }

        private func sendToPage(_ event: AppleSpeechEvent) {
            guard let data = try? JSONEncoder().encode(event),
                  let json = String(data: data, encoding: .utf8) else { return }
            webView?.evaluateJavaScript("window.tableauAppleSpeechEvent?.(\(json))")
        }

        // La dictée reste une fonctionnalité de la page web locale. WKWebView
        // exige toutefois que l'hôte natif tranche explicitement la demande
        // de capture. On n'accorde jamais ce droit à une origine distante.
        func webView(
            _ webView: WKWebView,
            requestMediaCapturePermissionFor origin: WKSecurityOrigin,
            initiatedByFrame frame: WKFrameInfo,
            type: WKMediaCaptureType,
            decisionHandler: @escaping (WKPermissionDecision) -> Void
        ) {
            if origin.protocol == "http", origin.host == "127.0.0.1", origin.port == tableauPort {
                decisionHandler(.grant)
            } else {
                decisionHandler(.prompt)
            }
        }
    }
}
