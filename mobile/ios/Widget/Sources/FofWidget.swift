import WidgetKit
import SwiftUI

private let group = "group.com.fof.music.ios"

struct NowEntry: TimelineEntry {
    let date: Date
    let title: String
    let artist: String
    let playing: Bool
    let art: UIImage?
}

struct NowProvider: TimelineProvider {
    func read() -> NowEntry {
        let d = UserDefaults(suiteName: group)
        var img: UIImage? = nil
        if let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group),
           let data = try? Data(contentsOf: dir.appendingPathComponent("art.jpg")) { img = UIImage(data: data) }
        return NowEntry(date: Date(), title: d?.string(forKey: "title") ?? "", artist: d?.string(forKey: "artist") ?? "", playing: d?.bool(forKey: "playing") ?? false, art: img)
    }
    func placeholder(in context: Context) -> NowEntry { NowEntry(date: Date(), title: "Fof Flow", artist: "Fof Music", playing: false, art: nil) }
    func getSnapshot(in context: Context, completion: @escaping (NowEntry) -> Void) { completion(read()) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<NowEntry>) -> Void) {
        completion(Timeline(entries: [read()], policy: .after(Date().addingTimeInterval(30 * 60))))
    }
}

private struct Cover: View {
    let img: UIImage?
    let size: CGFloat
    var body: some View {
        Group {
            if let img { Image(uiImage: img).resizable().scaledToFill() }
            else {
                ZStack {
                    Color(red: 0.16, green: 0.16, blue: 0.18)
                    Image(systemName: "music.note").font(.system(size: size * 0.38, weight: .semibold)).foregroundStyle(.secondary)
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.18, style: .continuous))
    }
}

private let red = Color(red: 1, green: 0.18, blue: 0.24)

struct NowSmall: View {
    let e: NowEntry
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top) {
                Cover(img: e.art, size: 58)
                Spacer()
                Image(systemName: e.playing ? "waveform" : "play.circle.fill").font(.system(size: 22, weight: .semibold)).foregroundStyle(red)
            }
            Spacer(minLength: 6)
            Text(e.title.isEmpty ? "Fof Flow" : e.title).font(.system(size: 15, weight: .semibold)).lineLimit(2)
            Text(e.artist.isEmpty ? "Tap to play" : e.artist).font(.system(size: 13)).foregroundStyle(.secondary).lineLimit(1)
        }
        .widgetURL(URL(string: e.title.isEmpty ? "fofmusic://flow" : "fofmusic://open"))
    }
}

struct NowMedium: View {
    let e: NowEntry
    var body: some View {
        HStack(spacing: 14) {
            Cover(img: e.art, size: 112)
            VStack(alignment: .leading, spacing: 2) {
                Text(e.title.isEmpty ? "Nothing playing" : e.title).font(.system(size: 16, weight: .semibold)).lineLimit(2)
                Text(e.artist.isEmpty ? "Fof Music" : e.artist).font(.system(size: 14)).foregroundStyle(.secondary).lineLimit(1)
                Spacer(minLength: 8)
                HStack(spacing: 0) {
                    Link(destination: URL(string: "fofmusic://toggle")!) {
                        Image(systemName: e.playing ? "pause.fill" : "play.fill").font(.system(size: 22, weight: .semibold)).frame(maxWidth: .infinity, minHeight: 36)
                    }
                    Link(destination: URL(string: "fofmusic://next")!) {
                        Image(systemName: "forward.fill").font(.system(size: 22, weight: .semibold)).frame(maxWidth: .infinity, minHeight: 36)
                    }
                }
                .foregroundStyle(.primary)
                Link(destination: URL(string: "fofmusic://flow")!) {
                    Label("Play Fof Flow", systemImage: "waveform").font(.system(size: 13, weight: .semibold)).foregroundStyle(red)
                }
            }
            Spacer(minLength: 0)
        }
    }
}

struct NowView: View {
    @Environment(\.widgetFamily) var family
    let e: NowEntry
    var body: some View {
        Group { if family == .systemMedium { NowMedium(e: e) } else { NowSmall(e: e) } }
            .containerBackground(for: .widget) { Color(red: 0.11, green: 0.11, blue: 0.12) }
            .environment(\.colorScheme, .dark)
    }
}

struct FofNowWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "FofNow", provider: NowProvider()) { NowView(e: $0) }
            .configurationDisplayName("Fof Music")
            .description("What's playing, with play, skip and Fof Flow.")
            .supportedFamilies([.systemSmall, .systemMedium])
    }
}

@main
struct FofWidgets: WidgetBundle {
    var body: some Widget { FofNowWidget() }
}
