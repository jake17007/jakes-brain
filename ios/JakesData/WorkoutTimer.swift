import ActivityKit
import Foundation
import UserNotifications

/// The Workout app's rest and hold timers outside the web view. The page posts
/// `{type: "timer", action, end, label, title, body}` (see web/apps/workout/lib.js):
///   start  — (re)schedule a notification for `end` that dings, and start or update the
///            Live Activity countdown on the lock screen and in the Dynamic Island
///   finish — the timer ran out while the page was open: end the Live Activity but leave the
///            notification alone (it is the ding, and removing it here could race it)
///   stop   — skipped or cancelled: drop the pending notification and end the Live Activity
@MainActor
final class WorkoutTimer {
    static let shared = WorkoutTimer()

    /// Every timer notification id starts with this; `ReminderScheduler` uses it to tell them apart.
    static let notificationPrefix = "workout.timer."
    private static let sound = UNNotificationSoundName("ding.caf")

    func handle(_ body: [String: Any]) {
        switch body["action"] as? String {
        case "start":
            guard let ms = (body["end"] as? NSNumber)?.doubleValue else { return }
            let end = Date(timeIntervalSince1970: ms / 1000)
            guard end.timeIntervalSinceNow > 0.5 else { return }
            let label = Self.text(body["label"], fallback: "Rest")
            let title = Self.text(body["title"], fallback: "\(label) over")
            let message = Self.text(body["body"], fallback: "")
            schedule(end: end, title: title, body: message)
            showActivity(end: end, label: label, doneText: title)
        case "finish":
            endActivities()
        case "stop":
            enqueue { await self.removePending(all: true) }
            endActivities()
        default:
            break
        }
    }

    private static func text(_ value: Any?, fallback: String) -> String {
        guard let string = value as? String else { return fallback }
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? fallback : String(trimmed.prefix(120))
    }

    // MARK: Notification (the ding)

    /// Notification work runs one step at a time, so a quick start-then-skip can't leave a
    /// notification behind that was added after the skip removed the others.
    private var queue: Task<Void, Never>?
    private func enqueue(_ step: @escaping @MainActor () async -> Void) {
        let previous = queue
        queue = Task { @MainActor in
            await previous?.value
            await step()
        }
    }

    private func schedule(end: Date, title: String, body: String) {
        enqueue {
            let center = UNUserNotificationCenter.current()
            let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            guard granted else { return }
            // A timer that is about to fire (or just fired) keeps its ding; later ones are replaced.
            await self.removePending(all: false)
            let content = UNMutableNotificationContent()
            content.title = title
            if !body.isEmpty { content.body = body }
            content.sound = UNNotificationSound(named: Self.sound)
            content.interruptionLevel = .active
            content.threadIdentifier = "workout.timer"
            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: max(1, end.timeIntervalSinceNow), repeats: false)
            let id = Self.notificationPrefix + String(Int(end.timeIntervalSince1970 * 1000))
            try? await center.add(UNNotificationRequest(identifier: id, content: content, trigger: trigger))
        }
    }

    /// Removes pending timer notifications: all of them, or only those more than 2 s away.
    private func removePending(all: Bool) async {
        let center = UNUserNotificationCenter.current()
        let soon = Date().addingTimeInterval(2)
        let ids = await center.pendingNotificationRequests()
            .filter { $0.identifier.hasPrefix(Self.notificationPrefix) }
            .filter { request in
                guard !all, let trigger = request.trigger as? UNTimeIntervalNotificationTrigger,
                      let next = trigger.nextTriggerDate() else { return true }
                return next > soon
            }
            .map(\.identifier)
        if !ids.isEmpty { center.removePendingNotificationRequests(withIdentifiers: ids) }
    }

    // MARK: Live Activity (the countdown outside the app)

    private func showActivity(end: Date, label: String, doneText: String) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let state = WorkoutTimerAttributes.ContentState(start: Date(), end: end, label: label, doneText: doneText)
        // Stale at `end`: the widget then shows "Rest over" instead of a frozen 0:00.
        let content = ActivityContent(state: state, staleDate: end)
        let running = Activity<WorkoutTimerAttributes>.activities
        if let current = running.first {
            Task { await current.update(content) }
            for extra in running.dropFirst() {
                Task { await extra.end(nil, dismissalPolicy: .immediate) }
            }
        } else {
            _ = try? Activity.request(attributes: WorkoutTimerAttributes(), content: content, pushType: nil)
        }
    }

    private func endActivities() {
        for activity in Activity<WorkoutTimerAttributes>.activities {
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
        }
    }
}
