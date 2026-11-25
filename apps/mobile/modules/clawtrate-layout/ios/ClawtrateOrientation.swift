import ExpoModulesCore
import UIKit

/// Which way the app may turn. app.json keeps the app upright (portrait), and
/// that stays true on every iPhone and on iPhone Duo's outer display. A window
/// that `ClawtrateLayoutView` finds on a hinged device at regular width, the
/// unfolded inner display, may turn every way but upside down.
public final class ClawtrateOrientation: ExpoAppDelegateSubscriber {
  private static let turning = NSHashTable<UIWindow>.weakObjects()

  static func allowTurning(_ window: UIWindow, _ allowed: Bool) {
    guard turning.contains(window) != allowed else { return }
    if allowed { turning.add(window) } else { turning.remove(window) }
    window.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
  }

  public func application(
    _ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?
  ) -> UIInterfaceOrientationMask {
    guard let window, Self.turning.contains(window) else { return .portrait }
    return .allButUpsideDown
  }
}
