import ExpoModulesCore
import OSLog
import UIKit

/// An invisible view that fills the window and reports, whenever its layout or
/// traits change, what the screen layout needs from UIKit: the size, whether the
/// device has a hinge, the horizontal size class, the edge the system keeps for
/// a vertical bar, the safe area, and the reserved regions (the fold is a
/// division, the camera block an occlusion). Positions are in this view's
/// coordinates, which are the window's.
///
/// The hinge, bar-edge and reserved-region APIs are new in the iOS 27.1 SDK
/// (UIKit 9127.0.85). Xcode 27.0's SDK lacks them, so the code that uses them is
/// compiled only with the newer SDK and runs only on iOS 27.1 or later. On any
/// other iPhone the view reports no hinge, no bar and no regions, and the app
/// keeps its phone layout.
final class ClawtrateLayoutView: ExpoView {
  let onLayoutChange = EventDispatcher()
  private static let log = Logger(subsystem: "dev.clawtrate.mobile", category: "layout")
  private var sent: NSDictionary?
  /// UIKit reports a hinge only on a device that has one; until it does, there is none.
  private var hasHinge = false

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
    registerForTraitChanges([UITraitHorizontalSizeClass.self, UITraitVerticalSizeClass.self]) {
      (view: ClawtrateLayoutView, _: UITraitCollection) in
      view.report()
    }
    #if canImport(UIKit, _version: 9127.0.85)
    if #available(iOS 27.1, *) {
      addInteraction(
        UIHingeInteraction { [weak self] _, update in
          // Having a hinge is the device's; the angle and the status do not change it.
          guard let self, update.hinge != nil, !self.hasHinge else { return }
          self.hasHinge = true
          self.report()
        })
      registerForTraitChanges(UITraitCollection.systemTraitsAffectingVerticalBarEdge) {
        (view: ClawtrateLayoutView, _: UITraitCollection) in
        view.report()
      }
    }
    #endif
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    sent = nil
    report()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    report()
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    report()
  }

  private func report() {
    guard let window, bounds.width > 0, bounds.height > 0 else { return }
    let regular = traitCollection.horizontalSizeClass == .regular
    var barEdge = "none"
    var regions: [[String: Any]] = []
    #if canImport(UIKit, _version: 9127.0.85)
    if #available(iOS 27.1, *) {
      let leftToRight = effectiveUserInterfaceLayoutDirection == .leftToRight
      switch traitCollection.verticalBarEdge {
      case .leading: barEdge = leftToRight ? "left" : "right"
      case .trailing: barEdge = leftToRight ? "right" : "left"
      default: break
      }
      let kinds: [(UIView.ReservedRegion.Kind, String)] = [(.division, "division"), (.occlusion, "occlusion")]
      for (kind, name) in kinds {
        for region in reservedRegions(kind: kind) where region.isActive {
          let frame = region.frame.intersection(bounds)
          guard !frame.isNull, !frame.isEmpty else { continue }
          regions.append([
            "kind": name,
            "x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height,
          ])
        }
      }
    }
    #endif
    // The inner display turns with the device; the outer one and every other iPhone stay upright.
    ClawtrateOrientation.allowTurning(window, hasHinge && regular)
    let insets = safeAreaInsets
    let metrics: [String: Any] = [
      "width": bounds.width,
      "height": bounds.height,
      "hasHinge": hasHinge,
      "sizeClass": regular ? "regular" : "compact",
      "verticalBarEdge": barEdge,
      "safeArea": [
        "top": insets.top, "bottom": insets.bottom, "left": insets.left, "right": insets.right,
      ],
      "regions": regions,
    ]
    let next = metrics as NSDictionary
    guard sent?.isEqual(next) != true else { return }
    sent = next
    onLayoutChange(metrics)
    // One line per change, so a check can tell what the app measured.
    Self.log.notice(
      "window \(Int(bounds.width), privacy: .public)x\(Int(bounds.height), privacy: .public) hinge=\(self.hasHinge, privacy: .public) sizeClass=\(regular ? "regular" : "compact", privacy: .public) bar=\(barEdge, privacy: .public) regions=\(regions.count, privacy: .public)"
    )
  }
}
