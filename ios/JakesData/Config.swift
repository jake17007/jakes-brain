import Foundation

enum Config {
    /// Public HTTPS gateway to the PC (Tailscale Funnel). The phone needs only an internet connection.
    static let origin = URL(string: "https://jakes-brain.tail7a4a30.ts.net")!
    static let candidates = [origin]
    static let userAgent = "JakeBrain/1.4"
    static let healthPath = "/api/health"
    static let healthTimeout: TimeInterval = 12

    // Old versions cached private IPs in UserDefaults. They are deliberately never read.
    static func allCandidates() -> [URL] { candidates }

    static func isAppURL(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https"
            && url.host?.lowercased() == origin.host?.lowercased()
            && (url.port == nil || url.port == 443)
            && url.user == nil && url.password == nil
    }

    static func addTransportHeaders(to request: inout URLRequest) {
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
    }
}
