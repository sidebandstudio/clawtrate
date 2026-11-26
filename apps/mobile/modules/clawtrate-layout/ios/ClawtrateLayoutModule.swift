import ExpoModulesCore

/// The view the app mounts once, under everything, to hear the window's shape.
public final class ClawtrateLayoutModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ClawtrateLayout")

    View(ClawtrateLayoutView.self) {
      Events("onLayoutChange")
    }
  }
}
