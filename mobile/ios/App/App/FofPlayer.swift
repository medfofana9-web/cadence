import Foundation
import AVFoundation
import MediaPlayer
import AVKit
import Capacitor

/// Fof Music's iPhone player: two AVPlayers that take turns (so the next song is ready and songs can blend),
/// lock screen / Control Center / CarPlay Now Playing, and remote controls. The web app drives it.
@objc(FofPlayerPlugin)
public class FofPlayerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FofPlayerPlugin"
    public let jsName = "FofPlayer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "load", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVolume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "nowPlaying", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hasFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "routePicker", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setEQ", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "download", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "widget", returnType: CAPPluginReturnPromise),
    ]

    private var players: [AVPlayer] = [AVPlayer(), AVPlayer()]
    private var observers: [[NSKeyValueObservation]] = [[], []]
    private var timeObs: [Any?] = [nil, nil]
    private var itemObs: [NSKeyValueObservation?] = [nil, nil]
    private var endObs: [NSObjectProtocol?] = [nil, nil]
    private var rates: [Float] = [1, 1]
    private var wantPlay: [Bool] = [false, false]
    private var active = 0
    private var artCache: (String, MPMediaItemArtwork)? = nil
    private var remoteReady = false

    public override func load() {
        for i in 0..<2 {
            players[i].automaticallyWaitsToMinimizeStalling = true
            let p = players[i]
            timeObs[i] = p.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main) { [weak self] t in
                guard let self = self else { return }
                let d = p.currentItem?.duration.seconds ?? 0
                self.notifyListeners("time", data: ["id": i, "t": t.seconds.isFinite ? t.seconds : 0, "d": d.isFinite ? d : 0])
            }
            observers[i].append(p.observe(\.timeControlStatus, options: [.new]) { [weak self] p, _ in
                guard let self = self else { return }
                let s: String
                switch p.timeControlStatus { case .playing: s = "playing"; case .paused: s = "paused"; default: s = "waiting" }
                self.notifyListeners("state", data: ["id": i, "state": s])
            })
        }
        let c = NotificationCenter.default
        c.addObserver(self, selector: #selector(interrupted(_:)), name: AVAudioSession.interruptionNotification, object: nil)
        c.addObserver(self, selector: #selector(routeChanged(_:)), name: AVAudioSession.routeChangeNotification, object: nil)
        setupRemote()
    }

    // MARK: playback
    @objc func load(_ call: CAPPluginCall) {
        let i = call.getInt("id") ?? 0
        guard let s = call.getString("url"), let url = s.hasPrefix("/") ? URL(fileURLWithPath: s) : URL(string: s) else { return call.reject("bad url") }
        let start = call.getDouble("start") ?? 0
        let autoplay = call.getBool("autoplay") ?? true
        DispatchQueue.main.async {
            let p = self.players[i]
            let item = AVPlayerItem(asset: AVURLAsset(url: url))
            item.preferredForwardBufferDuration = 20
            FofEQ.attach(to: item)
            self.itemObs[i] = item.observe(\.status, options: [.new]) { [weak self] it, _ in
                guard let self = self else { return }
                if it.status == .readyToPlay { let d = it.duration.seconds; self.notifyListeners("ready", data: ["id": i, "d": d.isFinite ? d : 0]) }
                else if it.status == .failed { self.notifyListeners("error", data: ["id": i, "message": it.error?.localizedDescription ?? "failed"]) }
            }
            if let e = self.endObs[i] { NotificationCenter.default.removeObserver(e) }
            self.endObs[i] = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
                self?.notifyListeners("ended", data: ["id": i])
            }
            p.replaceCurrentItem(with: item)
            if start > 0 { p.seek(to: CMTime(seconds: start, preferredTimescale: 600)) }
            self.wantPlay[i] = autoplay
            if autoplay { try? AVAudioSession.sharedInstance().setActive(true); p.playImmediately(atRate: self.rates[i]) }
            call.resolve()
        }
    }
    @objc func play(_ call: CAPPluginCall) {
        let i = call.getInt("id") ?? 0
        DispatchQueue.main.async {
            try? AVAudioSession.sharedInstance().setActive(true)
            self.wantPlay[i] = true; self.players[i].playImmediately(atRate: self.rates[i]); self.active = i; self.updateElapsed(); call.resolve()
        }
    }
    @objc func pause(_ call: CAPPluginCall) {
        let i = call.getInt("id") ?? 0
        DispatchQueue.main.async { self.wantPlay[i] = false; self.players[i].pause(); self.updateElapsed(); call.resolve() }
    }
    @objc func seek(_ call: CAPPluginCall) {
        let i = call.getInt("id") ?? 0, t = call.getDouble("time") ?? 0
        DispatchQueue.main.async {
            self.players[i].seek(to: CMTime(seconds: t, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: CMTime(seconds: 0.2, preferredTimescale: 600)) { _ in
                self.notifyListeners("seeked", data: ["id": i, "t": t]); self.updateElapsed()
            }
            call.resolve()
        }
    }
    @objc func setVolume(_ call: CAPPluginCall) {
        let i = call.getInt("id") ?? 0, v = Float(call.getDouble("volume") ?? 1)
        DispatchQueue.main.async { self.players[i].volume = max(0, min(1, v)); call.resolve() }
    }
    @objc func setRate(_ call: CAPPluginCall) {
        let i = call.getInt("id") ?? 0, r = Float(call.getDouble("rate") ?? 1)
        DispatchQueue.main.async { self.rates[i] = r; if self.players[i].rate > 0 { self.players[i].rate = r }; call.resolve() }
    }
    @objc func stop(_ call: CAPPluginCall) {
        let i = call.getInt("id") ?? 0
        DispatchQueue.main.async { self.wantPlay[i] = false; self.players[i].pause(); self.players[i].replaceCurrentItem(with: nil); call.resolve() }
    }

    // MARK: songs saved on the phone (the web app hands over the file in pieces)
    private func dir() -> URL {
        let d = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("fof-audio")
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }
    @objc func writeFile(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), let b64 = call.getString("data"), let data = Data(base64Encoded: b64) else { return call.reject("bad data") }
        let url = dir().appendingPathComponent(name)
        if call.getBool("append") == true, let h = try? FileHandle(forWritingTo: url) {
            h.seekToEndOfFile(); h.write(data); h.closeFile()
        } else { try? data.write(to: url) }
        call.resolve(["path": url.path])
    }
    @objc func hasFile(_ call: CAPPluginCall) {
        guard let name = call.getString("name") else { return call.resolve(["path": ""]) }
        let url = dir().appendingPathComponent(name)
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
        call.resolve(["path": size > 0 && size == (call.getInt("size") ?? size) ? url.path : ""])
    }

    // MARK: equalizer
    @objc func setEQ(_ call: CAPPluginCall) {
        let g = (call.getArray("gains", Double.self) ?? []).prefix(5)
        var out = [Double](repeating: 0, count: 5)
        for (i, v) in g.enumerated() { out[i] = max(-12, min(12, v)) }
        FofEQ.gains = out
        call.resolve()
    }

    // MARK: podcast episodes saved for offline
    @objc func download(_ call: CAPPluginCall) {
        guard let s = call.getString("url"), let u = URL(string: s), let name = call.getString("name") else { return call.reject("bad url") }
        let dest = dir().appendingPathComponent(name)
        if FileManager.default.fileExists(atPath: dest.path) { return call.resolve(["path": dest.path]) }
        URLSession.shared.downloadTask(with: u) { tmp, resp, err in
            guard let tmp = tmp, err == nil, ((resp as? HTTPURLResponse)?.statusCode ?? 200) < 400 else { return call.reject(err?.localizedDescription ?? "download failed") }
            try? FileManager.default.removeItem(at: dest)
            do { try FileManager.default.moveItem(at: tmp, to: dest); call.resolve(["path": dest.path]) }
            catch { call.reject(error.localizedDescription) }
        }.resume()
    }
    @objc func removeFile(_ call: CAPPluginCall) {
        if let name = call.getString("name") { try? FileManager.default.removeItem(at: dir().appendingPathComponent(name)) }
        call.resolve()
    }

    // MARK: home screen widget (reads what's playing from the shared app group)
    @objc func widget(_ call: CAPPluginCall) {
        FofWidgetBridge.update(title: call.getString("title") ?? "", artist: call.getString("artist") ?? "", playing: call.getBool("playing") ?? false, art: call.getString("artData"))
        call.resolve()
    }

    // MARK: lock screen, Control Center, CarPlay
    @objc func nowPlaying(_ call: CAPPluginCall) {
        let i = call.getInt("id") ?? active
        active = i
        let book = call.getBool("book") ?? false
        DispatchQueue.main.async { self.setupRemote(); self.setBookMode(book) }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: call.getString("title") ?? "",
            MPMediaItemPropertyArtist: call.getString("artist") ?? "",
            MPMediaItemPropertyAlbumTitle: call.getString("album") ?? "",
        ]
        if let d = call.getDouble("duration"), d > 0 { info[MPMediaItemPropertyPlaybackDuration] = d }
        if let (u, art) = artCache, u == (call.getString("artKey") ?? call.getString("art")) { info[MPMediaItemPropertyArtwork] = art }
        DispatchQueue.main.async {
            let p = self.players[i]
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = p.currentTime().seconds.isFinite ? p.currentTime().seconds : 0
            info[MPNowPlayingInfoPropertyPlaybackRate] = p.rate
            MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            call.resolve()
        }
        if let key = call.getString("artKey"), artCache?.0 != key, let b64 = call.getString("artData"), let data = Data(base64Encoded: b64), let img = UIImage(data: data) {
            let art = MPMediaItemArtwork(boundsSize: img.size) { _ in img }
            artCache = (key, art)
            DispatchQueue.main.async {
                var cur = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
                cur[MPMediaItemPropertyArtwork] = art
                MPNowPlayingInfoCenter.default().nowPlayingInfo = cur
            }
        } else if let s = call.getString("art"), artCache?.0 != s, let u = URL(string: s) {
            URLSession.shared.dataTask(with: u) { data, _, _ in
                guard let data = data, let img = UIImage(data: data) else { return }
                let art = MPMediaItemArtwork(boundsSize: img.size) { _ in img }
                self.artCache = (s, art)
                DispatchQueue.main.async {
                    var cur = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
                    cur[MPMediaItemPropertyArtwork] = art
                    MPNowPlayingInfoCenter.default().nowPlayingInfo = cur
                }
            }.resume()
        }
    }
    private func updateElapsed() {
        var cur = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        let p = players[active]
        cur[MPNowPlayingInfoPropertyElapsedPlaybackTime] = p.currentTime().seconds.isFinite ? p.currentTime().seconds : 0
        cur[MPNowPlayingInfoPropertyPlaybackRate] = p.rate
        MPNowPlayingInfoCenter.default().nowPlayingInfo = cur
    }
    private func setupRemote() {
        guard !remoteReady else { return }
        remoteReady = true
        let r = MPRemoteCommandCenter.shared()
        let send: (String, Double?) -> MPRemoteCommandHandlerStatus = { [weak self] a, t in
            var d: [String: Any] = ["action": a]; if let t = t { d["time"] = t }
            self?.notifyListeners("remote", data: d); return .success
        }
        r.playCommand.addTarget { _ in send("play", nil) }
        r.pauseCommand.addTarget { _ in send("pause", nil) }
        r.togglePlayPauseCommand.addTarget { _ in send("toggle", nil) }
        r.nextTrackCommand.addTarget { _ in send("next", nil) }
        r.previousTrackCommand.addTarget { _ in send("prev", nil) }
        r.changePlaybackPositionCommand.addTarget { e in send("seek", (e as? MPChangePlaybackPositionCommandEvent)?.positionTime) }
        r.skipForwardCommand.preferredIntervals = [30]
        r.skipBackwardCommand.preferredIntervals = [15]
        r.skipForwardCommand.addTarget { _ in send("fwd30", nil) }
        r.skipBackwardCommand.addTarget { _ in send("back15", nil) }
        setBookMode(false)
    }
    /// Audiobooks show 15 / 30 second skips on the lock screen instead of previous / next track.
    private func setBookMode(_ on: Bool) {
        let r = MPRemoteCommandCenter.shared()
        r.skipForwardCommand.isEnabled = on
        r.skipBackwardCommand.isEnabled = on
        r.nextTrackCommand.isEnabled = !on
        r.previousTrackCommand.isEnabled = !on
    }

    // MARK: calls, Siri, unplugged headphones
    @objc private func interrupted(_ n: Notification) {
        guard let t = (n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init) else { return }
        if t == .began { notifyListeners("remote", data: ["action": "interrupted"]) }
        else if let o = n.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt, AVAudioSession.InterruptionOptions(rawValue: o).contains(.shouldResume) {
            notifyListeners("remote", data: ["action": "resume"])
        }
    }
    @objc private func routeChanged(_ n: Notification) {
        guard let r = (n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt).flatMap(AVAudioSession.RouteChangeReason.init) else { return }
        if r == .oldDeviceUnavailable { notifyListeners("remote", data: ["action": "pause"]) }
    }

    // MARK: AirPlay
    @objc func routePicker(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let v = AVRoutePickerView(frame: .zero)
            self.bridge?.viewController?.view.addSubview(v)
            if let b = v.subviews.compactMap({ $0 as? UIButton }).first { b.sendActions(for: .touchUpInside) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { v.removeFromSuperview() }
            call.resolve()
        }
    }
}
