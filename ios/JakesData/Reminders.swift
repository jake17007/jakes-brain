import UIKit
import UserNotifications
import WebKit

/// Reads pending reminders from the PC and schedules them as iOS notifications, so they pop up
/// on time with the app closed. Without Apple push, a reminder added elsewhere reaches the
/// phone the next time this runs, which is whenever the app is open or next opened.
@MainActor
final class ReminderScheduler: NSObject, UNUserNotificationCenterDelegate {
    static let shared = ReminderScheduler()

    private struct Payload: Decodable { let reminders: [Item] }
    private struct Item: Decodable { let id: Int; let title: String; let due_at: String }

    private static let syncSeconds: TimeInterval = 15
    private static let iosPendingLimit = 60
    private static let firedKey = "reminders.fired"

    private weak var webView: WKWebView?
    private var timer: Timer?
    private var syncing = false
    private var reportedStatus: String?

    func attach(_ webView: WKWebView) {
        self.webView = webView
        if timer == nil {
            timer = Timer.scheduledTimer(withTimeInterval: Self.syncSeconds, repeats: true) { _ in
                Task { @MainActor in ReminderScheduler.shared.sync() }
            }
            NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
                Task { @MainActor in ReminderScheduler.shared.sync() }
            }
        }
        sync()
    }

    func sync() {
        guard !syncing, UIApplication.shared.applicationState == .active, let page = webView?.url,
              Config.isAppURL(page),
              var parts = URLComponents(url: page, resolvingAgainstBaseURL: false) else { return }
        parts.query = nil
        parts.fragment = nil
        parts.path = "/api/reminders/device"
        guard let deviceURL = parts.url else { return }
        parts.path = "/api/reminders"
        parts.query = "pending=1"
        guard let listURL = parts.url else { return }
        syncing = true
        Task {
            defer { syncing = false }
            let center = UNUserNotificationCenter.current()
            let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            await report(granted ? "authorized" : "denied", to: deviceURL)
            guard granted, let items = await fetch(listURL) else { return }
            await schedule(items, center)
        }
    }

    private func report(_ status: String, to url: URL) async {
        guard reportedStatus != status else { return }
        guard let webView, var request = try? await NativeHTTP.request(to: url, webView: webView) else { return }
        request.httpMethod = "POST"
        request.timeoutInterval = 8
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["status": status, "version": version])
        if let (_, response) = try? await NativeHTTP.session.data(for: request), (response as? HTTPURLResponse)?.statusCode == 200 {
            reportedStatus = status
        }
    }

    private func fetch(_ url: URL) async -> [Item]? {
        guard let webView, var request = try? await NativeHTTP.request(to: url, webView: webView) else { return nil }
        request.timeoutInterval = 8
        guard let (data, response) = try? await NativeHTTP.session.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return (try? JSONDecoder().decode(Payload.self, from: data))?.reminders
    }

    private func schedule(_ items: [Item], _ center: UNUserNotificationCenter) async {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let wanted = Dictionary(uniqueKeysWithValues: items.map { ("\($0.id)@\($0.due_at)", $0) })
        let pending = await center.pendingNotificationRequests()
        var scheduled = Set<String>()
        // The Workout timer's notifications are not reminders; WorkoutTimer owns them.
        for request in pending where !request.identifier.hasPrefix(WorkoutTimer.notificationPrefix) {
            if wanted[request.identifier] == nil {
                center.removePendingNotificationRequests(withIdentifiers: [request.identifier])
            } else {
                scheduled.insert(request.identifier)
            }
        }
        var fired = Set(UserDefaults.standard.stringArray(forKey: Self.firedKey) ?? [])
        for item in items where scheduled.count < Self.iosPendingLimit {
            let key = "\(item.id)@\(item.due_at)"
            guard !scheduled.contains(key), !fired.contains(key), let due = parser.date(from: item.due_at) else { continue }
            let content = UNMutableNotificationContent()
            content.title = item.title
            content.body = "Reminder"
            content.sound = .default
            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: max(1, due.timeIntervalSinceNow), repeats: false)
            try? await center.add(UNNotificationRequest(identifier: key, content: content, trigger: trigger))
            // Recorded once scheduled, so a reminder that fired while the app was closed is not
            // sent a second time when it shows up overdue on the next sync.
            fired.insert(key)
            scheduled.insert(key)
        }
        UserDefaults.standard.set(Array(fired.suffix(500)), forKey: Self.firedKey)
    }

    private func open(_ hash: String) {
        webView?.evaluateJavaScript("location.hash = '\(hash)'") { _, _ in }
    }

    private nonisolated static func isWorkoutTimer(_ notification: UNNotification) -> Bool {
        notification.request.identifier.hasPrefix("workout.timer.")
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        // A rest/hold timer ending while the app is open: ding and show it, but keep it out of
        // Notification Center (the workout screen already says so).
        completionHandler(Self.isWorkoutTimer(notification) ? [.banner, .sound] : [.banner, .list, .sound])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let hash = Self.isWorkoutTimer(response.notification) ? "#/workout/active" : "#/reminders"
        Task { @MainActor in ReminderScheduler.shared.open(hash) }
        completionHandler()
    }
}
