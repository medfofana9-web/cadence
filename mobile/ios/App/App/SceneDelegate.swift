import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = FofViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
        if let u = connectionOptions.urlContexts.first?.url { handle(u) }
    }

    /// fofmusic://flow, fofmusic://toggle … from the home screen widget.
    private func handle(_ url: URL) {
        guard url.scheme == "fofmusic", let a = url.host, !a.isEmpty else { return }
        if a == "want" { // fofmusic://want/Artist - Title, from the Shazam Shortcut
            let rest = url.absoluteString.components(separatedBy: "://want/").dropFirst().joined()
            FofSiri.run("want/" + rest)
            return
        }
        FofSiri.run(a)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for c in URLContexts { handle(c.url) }
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
