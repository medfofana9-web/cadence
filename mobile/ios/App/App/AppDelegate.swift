import UIKit
import AVFoundation
import Capacitor
import WebKit

// Fof Music for iPhone: the live Fof Music app (medfofana9-web.github.io/cadence) in a native shell.
// Web updates show up on their own; this shell adds background audio, lock-screen playback and a home-screen icon.

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // music keeps playing with the screen locked or in another app, and plays with the silent switch on
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, policy: .longFormAudio)
        try? AVAudioSession.sharedInstance().setActive(true)
        application.beginReceivingRemoteControlEvents()
        return true
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }
}


/// The Fof Music web view, set up for a music app: songs start without an extra tap, play inline, and can go to AirPlay.
class FofViewController: CAPBridgeViewController {
    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let config = super.webViewConfiguration(for: instanceConfiguration)
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsAirPlayForMediaPlayback = true
        config.allowsPictureInPictureMediaPlayback = true
        return config
    }

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(FofNativePlugin())
        bridge?.registerPluginInstance(FofPlayerPlugin())
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 9 / 255, green: 9 / 255, blue: 10 / 255, alpha: 1)
        webView?.isOpaque = false
        webView?.backgroundColor = view.backgroundColor
        webView?.scrollView.backgroundColor = view.backgroundColor
        webView?.scrollView.contentInsetAdjustmentBehavior = .never
        webView?.allowsBackForwardNavigationGestures = false
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
}

/// Tells the web app it is the installed iPhone app, when the free 7-day signing runs out, and opens SideStore to renew.
@objc(FofNativePlugin)
public class FofNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FofNativePlugin"
    public let jsName = "FofNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "info", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSideStore", returnType: CAPPluginReturnPromise),
    ]

    public override func load() {
        NotificationCenter.default.addObserver(forName: .init("FofSiri"), object: nil, queue: .main) { [weak self] n in
            if let a = n.object as? String { FofSiri.pending = nil; self?.notifyListeners("siri", data: ["action": a]) }
        }
    }

    @objc func info(_ call: CAPPluginCall) {
        var out: [String: Any] = [
            "version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "",
            "build": Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "",
        ]
        if let d = FofNativePlugin.profileExpiry() { out["expires"] = ISO8601DateFormatter().string(from: d) }
        if let a = FofSiri.pending { out["siri"] = a; FofSiri.pending = nil }
        out["player"] = true
        call.resolve(out)
    }

    @objc func openSideStore(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            for s in ["sidestore://", "altstore://"] {
                if let u = URL(string: s), UIApplication.shared.canOpenURL(u) { UIApplication.shared.open(u); break }
            }
            call.resolve()
        }
    }

    static func profileExpiry() -> Date? {
        guard let path = Bundle.main.path(forResource: "embedded", ofType: "mobileprovision"),
              let data = FileManager.default.contents(atPath: path),
              let text = String(data: data, encoding: .isoLatin1),
              let start = text.range(of: "<?xml"), let end = text.range(of: "</plist>") else { return nil }
        let xml = String(text[start.lowerBound..<end.upperBound])
        guard let plist = try? PropertyListSerialization.propertyList(from: Data(xml.utf8), options: [], format: nil) as? [String: Any] else { return nil }
        return plist["ExpirationDate"] as? Date
    }
}
