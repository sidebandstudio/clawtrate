import ExpoModulesCore
import UIKit

/// The share sheet for one file a bot handed over (`src/host/share.ts`; docs/decisions.md, The
/// iOS app). It answers once the sheet is done with, every way that happens. React Native's
/// `Share` gives no answer when an activity was chosen and then cancelled, such as Save to Files
/// with its picker cancelled, so its caller waited for good and the file was never deleted.
public final class ClawtrateShareModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ClawtrateShare")

    /// Settles with whether an activity finished (`completed`) and which (`activityType`, empty
    /// when none), once the sheet is closed or an activity is done with.
    AsyncFunction("share") { (uri: String, promise: Promise) in
      guard let url = URL(string: uri), url.isFileURL else {
        return promise.reject("ERR_ADDRESS", "Only a file of the app's own is shared.")
      }
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        return promise.reject("ERR_NO_SCREEN", "There is no screen to open the share sheet on.")
      }
      let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
      var settled = false
      let settle = { (completed: Bool, activityType: String) in
        if settled { return }
        settled = true
        promise.resolve(["completed": completed, "activityType": activityType])
      }
      /// Off the screen: no longer presented, or out of any window.
      let gone = { [weak sheet] () -> Bool in
        guard let sheet else { return true }
        return sheet.presentingViewController == nil || sheet.viewIfLoaded?.window == nil
      }
      sheet.completionWithItemsHandler = { activityType, completed, _, error in
        if completed || error != nil || activityType == nil {
          return settle(completed && error == nil, activityType?.rawValue ?? "")
        }
        // An activity chosen, then cancelled. The sheet can still be up to choose another, and
        // then this is called again when it closes. When its activity took it off the screen,
        // nothing more comes: it is closed now, or once its dismissal has finished.
        if gone() { return settle(false, activityType?.rawValue ?? "") }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
          if gone() { settle(false, activityType?.rawValue ?? "") }
        }
      }
      // An iPad anchors the sheet to a view; an iPhone ignores this.
      sheet.popoverPresentationController?.sourceView = presenter.view
      presenter.present(sheet, animated: true)
    }.runOnQueue(.main)
  }
}
