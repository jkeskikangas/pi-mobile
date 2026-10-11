import SwiftUI
import WidgetKit

/// Placeholder bundle so the extension builds; the Live Activity and Control widget arrive in plan Step 7.
@main
struct PiWidgetsBundle: WidgetBundle {
    var body: some Widget {
        PiPlaceholderWidget()
    }
}

struct PiPlaceholderWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "pi.placeholder", provider: Provider()) { _ in
            Text("π")
                .font(.system(size: 40, weight: .semibold, design: .serif))
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("pi")
        .description("Open pi.")
        .supportedFamilies([.systemSmall])
    }

    struct Provider: TimelineProvider {
        func placeholder(in context: Context) -> SimpleEntry { SimpleEntry(date: .now) }
        func getSnapshot(in context: Context, completion: @escaping (SimpleEntry) -> Void) { completion(SimpleEntry(date: .now)) }
        func getTimeline(in context: Context, completion: @escaping (Timeline<SimpleEntry>) -> Void) {
            completion(Timeline(entries: [SimpleEntry(date: .now)], policy: .never))
        }
    }

    struct SimpleEntry: TimelineEntry { let date: Date }
}
