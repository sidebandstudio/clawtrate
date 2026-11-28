import ExpoModulesCore
import UIKit

/// The share sheet for one file a bot handed over (`src/host/share.ts`; docs/decisions.md, The
/// iOS app). Each sheet settles exactly once, every way it can end, with one of `completed`,
/// `dismissed`, `failed`, `not-presented` or `no-screen` (`SheetEnd` in share.ts):
///
/// - Cancelled before it was presented (`cancel`, the row left the screen): `not-presented`.
/// - No view controller in a window to present from: `no-screen`, at once.
/// - An activity finished: `completed`. It failed: `failed`. The sheet closed with no activity
///   chosen: `dismissed`. Each from `completionWithItemsHandler`.
/// - An activity chosen and then cancelled (Save to Files with its picker cancelled): the handler
///   says so, and the sheet either stays up to choose another, when the handler comes again as it
///   closes, or is closed or closing: `dismissed` once it is off the screen (`viewDidDisappear`).
/// - Anything else, including a present iOS refused: when the sheet is freed, since nothing more
///   can come then. `no-screen` when it was never on screen (its present never completed),
///   `dismissed` otherwise. iOS holds a sheet it is presenting, or will present once a transition
///   ends, so it is never freed while it can still be on screen. No check made straight after
///   `present` decides anything: an animated present can attach later than that.
///
/// The file it offers is deleted only once it has settled, so never while the sheet may need it.
///
/// React Native's `Share` gives no answer at all after a cancelled activity, so its caller waited
/// for good and the file was never deleted. Everything here runs on the main queue.
public final class ClawtrateShareModule: Module {
  /// Sheets cancelled before they were presented, and those presented and not yet settled.
  private var cancelled = Set<String>()
  private var presented = Set<String>()

  public func definition() -> ModuleDefinition {
    Name("ClawtrateShare")

    AsyncFunction("share") { (id: String, uri: String, promise: Promise) in
      var settled = false
      let settle = { [weak self] (end: String, activityType: String?) in
        if settled { return }
        settled = true
        self?.presented.remove(id)
        promise.resolve(["end": end, "activityType": activityType ?? ""])
      }
      if self.cancelled.remove(id) != nil { return settle("not-presented", nil) }
      guard let url = URL(string: uri), url.isFileURL else {
        return promise.reject("ERR_ADDRESS", "Only a file of the app's own is shared.")
      }
      guard let presenter = Self.presenter() else { return settle("no-screen", nil) }

      let sheet = ClosingActivityViewController(activityItems: [url], applicationActivities: nil)
      /// An activity was chosen and then cancelled: the sheet's leaving ends it.
      var activityCancelled: String?
      /// Its present completed: it has been on screen.
      var shown = false
      sheet.completionWithItemsHandler = { [weak sheet] activityType, completed, _, error in
        let type = activityType?.rawValue
        if error != nil { return settle("failed", type) }
        if completed { return settle("completed", type) }
        if activityType == nil { return settle("dismissed", nil) }
        activityCancelled = type
        // Already off the screen: ended now. Being dismissed: `onLeft` ends it once it is off the
        // screen. Still up to choose another: the handler comes again as it closes.
        if sheet?.presentingViewController == nil { settle("dismissed", type) }
      }
      sheet.onLeft = { if let type = activityCancelled { settle("dismissed", type) } }
      sheet.onFreed = { settle(shown ? "dismissed" : "no-screen", activityCancelled) }
      // An iPad anchors the sheet to a view; an iPhone ignores this.
      sheet.popoverPresentationController?.sourceView = presenter.view
      self.presented.insert(id)
      presenter.present(sheet, animated: true) { shown = true }
    }.runOnQueue(.main)

    /// The row left the screen: a sheet not presented yet is presented nothing.
    AsyncFunction("cancel") { (id: String) in
      if !self.presented.contains(id) { self.cancelled.insert(id) }
    }.runOnQueue(.main)
  }

  /// The top-most view controller that is in a window and not being dismissed, or nil.
  private static func presenter() -> UIViewController? {
    let windows = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .filter { $0.activationState == .foregroundActive }
      .flatMap { $0.windows }
    guard var top = (windows.first { $0.isKeyWindow } ?? windows.first)?.rootViewController
    else { return nil }
    while let next = top.presentedViewController, !next.isBeingDismissed { top = next }
    guard top.viewIfLoaded?.window != nil, !top.isBeingDismissed, !top.isBeingPresented,
      top.presentedViewController == nil
    else { return nil }
    return top
  }
}

/// The share sheet, saying when it has left the screen for good and when it is freed.
private final class ClosingActivityViewController: UIActivityViewController {
  var onLeft: (() -> Void)?
  var onFreed: (() -> Void)?

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    // Covered by a screen it presented, it is still up; dismissed, it has left.
    if isBeingDismissed || presentingViewController == nil { onLeft?() }
  }

  deinit {
    let freed = onFreed
    DispatchQueue.main.async { freed?() }
  }
}
