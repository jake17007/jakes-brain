import ActivityKit
import Foundation

/// The Workout app's rest or hold timer as a Live Activity (lock screen + Dynamic Island).
/// Compiled into both the app (which starts, updates and ends it) and the RestTimer widget
/// extension (which draws it). The countdown text is drawn by the system from `start`/`end`,
/// so nothing has to update it while the app is closed.
struct WorkoutTimerAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// When the countdown began (for the progress bar).
        var start: Date
        /// When it reaches zero.
        var end: Date
        /// "Rest" or "Hold".
        var label: String
        /// Shown once `end` has passed, e.g. "Rest over".
        var doneText: String
    }
}
