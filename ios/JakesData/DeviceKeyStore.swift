import Foundation
import LocalAuthentication
import Security
import WebKit

/// Keeps the Finances unlock key in the Keychain behind Face ID / the iPhone passcode
/// (`.userPresence`, this device only), so the Finances page unlocks without typing the PIN.
/// Page -> native: { type: "devicekey", action: "store" | "unlock" | "clear", id, key?, request }
/// Native -> page: CustomEvent "jakesdata:devicekey" { request, ok, key?, error? }
/// error: "cancelled" (Face ID / passcode dismissed), "missing" (no key on this phone),
///        "nopasscode" (the phone has no passcode), "failed".
@MainActor
final class DeviceKeyStore {
    nonisolated private static let service = "com.jakebeau.jakesdata.finances-unlock"

    func handle(_ body: [String: Any], webView: WKWebView?) {
        let request = String((body["request"] as? String ?? "").prefix(40))
        guard let id = body["id"] as? String, !id.isEmpty, id.count <= 64 else {
            reply(webView, request, ["ok": false, "error": "failed"])
            return
        }
        switch body["action"] as? String {
        case "store":
            guard let key = body["key"] as? String, !key.isEmpty, key.count <= 256 else {
                reply(webView, request, ["ok": false, "error": "failed"])
                return
            }
            reply(webView, request, Self.store(id: id, key: key))
        case "unlock":
            // Reading a .userPresence item shows Face ID / the passcode and blocks the calling
            // thread until it is answered, so it never runs on the main thread.
            Task.detached { [weak self, weak webView] in
                let result = DeviceKeyStore.read(id: id)
                await MainActor.run { self?.reply(webView, request, result) }
            }
        case "clear":
            Self.delete(id: id)
            reply(webView, request, ["ok": true])
        default:
            reply(webView, request, ["ok": false, "error": "failed"])
        }
    }

    nonisolated private static func store(id: String, key: String) -> [String: Any] {
        delete(id: id)
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .userPresence, &error) else {
            return ["ok": false, "error": "failed"]
        }
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: id,
            kSecValueData as String: Data(key.utf8),
            kSecAttrAccessControl as String: access,
        ]
        let status = SecItemAdd(item as CFDictionary, nil)
        if status == errSecSuccess { return ["ok": true] }
        return ["ok": false, "error": status == errSecNotAvailable || status == errSecAuthFailed ? "nopasscode" : "failed"]
    }

    nonisolated private static func read(id: String) -> [String: Any] {
        let context = LAContext()
        context.localizedReason = "Unlock Finances"
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: id,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecUseAuthenticationContext as String: context,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecSuccess, let data = result as? Data, let key = String(data: data, encoding: .utf8) {
            return ["ok": true, "key": key]
        }
        switch status {
        case errSecUserCanceled: return ["ok": false, "error": "cancelled"]
        case errSecItemNotFound: return ["ok": false, "error": "missing"]
        default: return ["ok": false, "error": "failed"]
        }
    }

    nonisolated private static func delete(id: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: id,
        ]
        SecItemDelete(query as CFDictionary)
    }

    private func reply(_ webView: WKWebView?, _ request: String, _ payload: [String: Any]) {
        var detail = payload
        detail["request"] = request
        guard let data = try? JSONSerialization.data(withJSONObject: detail),
              let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('jakesdata:devicekey',{detail:\(json)}))") { _, _ in }
    }
}
