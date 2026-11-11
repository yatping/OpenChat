import UserNotifications

/// Replaces the fallback phrase with the workspace, sender and message, decrypted on this phone (ADR-0017).
/// On any failure, or when time runs out, the notification shows the fallback the relay sent.
class NotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var fallback: UNNotificationContent?

  override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    self.contentHandler = contentHandler
    fallback = request.content
    guard
      let content = request.content.mutableCopy() as? UNMutableNotificationContent,
      let oc = request.content.userInfo["oc"] as? [AnyHashable: Any],
      let opened = try? NotificationCrypto.open(oc: oc, key: { PreviewKeychain.load(subscriptionId: $0) }),
      !opened.text.isEmpty
    else {
      finish(request.content)
      return
    }
    content.title = opened.title
    content.body = opened.sender.isEmpty ? opened.text : "\(opened.sender): \(opened.text)"
    finish(content)
  }

  override func serviceExtensionTimeWillExpire() {
    if let fallback { finish(fallback) }
  }

  private func finish(_ content: UNNotificationContent) {
    contentHandler?(content)
    contentHandler = nil
  }
}
