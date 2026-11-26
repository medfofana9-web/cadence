import Foundation
import AppIntents

/// "Hey Siri, play Fof Flow in Fof Music" (and a few more), handed to the web app through FofNativePlugin.
enum FofSiri {
    static var pending: String? = nil
    static func run(_ action: String) {
        pending = action
        NotificationCenter.default.post(name: .init("FofSiri"), object: action)
    }
}

@available(iOS 16.0, *)
struct PlayFlowIntent: AppIntent {
    static var title: LocalizedStringResource = "Play Fof Flow"
    static var openAppWhenRun = true
    func perform() async throws -> some IntentResult { FofSiri.run("flow"); return .result() }
}
@available(iOS 16.0, *)
struct PlayLikedIntent: AppIntent {
    static var title: LocalizedStringResource = "Play Liked Songs"
    static var openAppWhenRun = true
    func perform() async throws -> some IntentResult { FofSiri.run("liked"); return .result() }
}
@available(iOS 16.0, *)
struct PlayQuranIntent: AppIntent {
    static var title: LocalizedStringResource = "Play Quran"
    static var openAppWhenRun = true
    func perform() async throws -> some IntentResult { FofSiri.run("quran"); return .result() }
}

@available(iOS 16.0, *)
struct FofShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: PlayFlowIntent(), phrases: ["Play Fof Flow in \(.applicationName)", "Play my flow in \(.applicationName)"], shortTitle: "Fof Flow", systemImageName: "waveform")
        AppShortcut(intent: PlayLikedIntent(), phrases: ["Play my liked songs in \(.applicationName)"], shortTitle: "Liked Songs", systemImageName: "heart.fill")
        AppShortcut(intent: PlayQuranIntent(), phrases: ["Play Quran in \(.applicationName)"], shortTitle: "Quran", systemImageName: "book.fill")
    }
}
