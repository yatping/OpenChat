import ExpoModulesCore

/// The app's side of encrypted notifications (ADR-0017). The private key never leaves the keychain.
public class NotificationKeysModule: Module {
  public func definition() -> ModuleDefinition {
    Name("NotificationKeys")

    AsyncFunction("createPreviewKey") { (subscriptionId: String) throws -> String in
      try PreviewKeychain.create(subscriptionId: subscriptionId)
    }

    AsyncFunction("hasPreviewKey") { (subscriptionId: String) -> Bool in
      PreviewKeychain.load(subscriptionId: subscriptionId) != nil
    }

    AsyncFunction("deletePreviewKey") { (subscriptionId: String) in
      PreviewKeychain.delete(subscriptionId: subscriptionId)
    }
  }
}
