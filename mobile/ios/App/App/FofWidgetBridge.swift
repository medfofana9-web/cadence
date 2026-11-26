import Foundation
import WidgetKit

/// Shares what's playing with the home screen widget.
enum FofWidgetBridge {
    static let group = "group.com.fof.music.ios"
    private static var last = ""
    static func update(title: String, artist: String, playing: Bool, art: String?) {
        guard let d = UserDefaults(suiteName: group) else { return }
        let key = "\(title)|\(artist)|\(playing)|\(art != nil)"
        guard key != last else { return }
        last = key
        d.set(title, forKey: "title"); d.set(artist, forKey: "artist"); d.set(playing, forKey: "playing")
        if let b64 = art, let data = Data(base64Encoded: b64), let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) {
            try? data.write(to: dir.appendingPathComponent("art.jpg"))
        }
        WidgetCenter.shared.reloadAllTimelines()
    }
}
