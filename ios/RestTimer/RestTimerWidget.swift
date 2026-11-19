import ActivityKit
import SwiftUI
import WidgetKit

/// The Workout tile colour (#2563eb).
private let workoutBlue = Color(red: 37 / 255, green: 99 / 255, blue: 235 / 255)

/// Widget extension that draws the Workout rest / hold timer Live Activity.
@main
struct RestTimerBundle: WidgetBundle {
    var body: some Widget {
        RestTimerLiveActivity()
    }
}

struct RestTimerLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: WorkoutTimerAttributes.self) { context in
            LockScreenTimer(state: context.state, isStale: context.isStale)
                .padding(16)
                .activityBackgroundTint(Color(.systemBackground))
                .activitySystemActionForegroundColor(workoutBlue)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label(context.state.label, systemImage: "timer")
                        .font(.headline)
                        .foregroundStyle(workoutBlue)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Countdown(state: context.state, isStale: context.isStale)
                        .font(.title2.weight(.bold))
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Progress(state: context.state, isStale: context.isStale)
                }
            } compactLeading: {
                Image(systemName: "timer").foregroundStyle(workoutBlue)
            } compactTrailing: {
                Countdown(state: context.state, isStale: context.isStale)
                    .frame(maxWidth: 52)
            } minimal: {
                Image(systemName: "timer").foregroundStyle(workoutBlue)
            }
            .keylineTint(workoutBlue)
        }
    }
}

/// A valid start...end range even if the clock has passed `end` or the dates arrive swapped.
private func span(_ state: WorkoutTimerAttributes.ContentState) -> ClosedRange<Date> {
    min(state.start, state.end)...state.end
}

private struct Countdown: View {
    let state: WorkoutTimerAttributes.ContentState
    let isStale: Bool

    var body: some View {
        if isStale || state.end <= .now {
            Text("0:00").monospacedDigit()
        } else {
            Text(timerInterval: span(state), countsDown: true)
                .monospacedDigit()
                .multilineTextAlignment(.trailing)
        }
    }
}

private struct Progress: View {
    let state: WorkoutTimerAttributes.ContentState
    let isStale: Bool

    var body: some View {
        if isStale || state.end <= .now {
            ProgressView(value: 1).tint(.green)
        } else {
            ProgressView(timerInterval: span(state), countsDown: true) { EmptyView() } currentValueLabel: { EmptyView() }
                .tint(workoutBlue)
        }
    }
}

private struct LockScreenTimer: View {
    let state: WorkoutTimerAttributes.ContentState
    let isStale: Bool

    var body: some View {
        let done = isStale || state.end <= .now
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Label(done ? state.doneText : state.label, systemImage: "timer")
                    .font(.headline)
                    .foregroundStyle(done ? Color.green : workoutBlue)
                Spacer()
                Countdown(state: state, isStale: isStale)
                    .font(.system(size: 34, weight: .bold))
            }
            Progress(state: state, isStale: isStale)
        }
    }
}
