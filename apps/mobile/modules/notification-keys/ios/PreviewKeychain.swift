import CryptoKit
import Foundation
import Security

/// One X25519 key per push subscription, in a keychain group that the app and its notification extension share.
/// The plugin in plugins/notification-service copies this file into the extension, so both read the same items.
enum PreviewKeychain {
  enum Failure: Error {
    case keychain(OSStatus)
  }

  private static let service = "openchat.notification-keys"

  /// `$(AppIdentifierPrefix)<bundle>.notifications`, written into each target's Info.plist by the config plugin.
  private static var accessGroup: String? {
    Bundle.main.object(forInfoDictionaryKey: "OCKeychainGroup") as? String
  }

  private static func query(_ subscriptionId: String) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: subscriptionId,
    ]
    if let group = accessGroup { query[kSecAttrAccessGroup as String] = group }
    return query
  }

  /// Returns the public key, 32 bytes as base64url. Readable after the first unlock, because a notification
  /// often arrives while the phone is locked. Never leaves this device, and never goes into a backup.
  static func create(subscriptionId: String) throws -> String {
    let key = Curve25519.KeyAgreement.PrivateKey()
    delete(subscriptionId: subscriptionId)
    var item = query(subscriptionId)
    item[kSecValueData as String] = key.rawRepresentation
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let status = SecItemAdd(item as CFDictionary, nil)
    guard status == errSecSuccess else { throw Failure.keychain(status) }
    return Base64URL.encode(key.publicKey.rawRepresentation)
  }

  static func load(subscriptionId: String) -> Curve25519.KeyAgreement.PrivateKey? {
    var search = query(subscriptionId)
    search[kSecReturnData as String] = true
    search[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    guard SecItemCopyMatching(search as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
    return try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: data)
  }

  static func delete(subscriptionId: String) {
    SecItemDelete(query(subscriptionId) as CFDictionary)
  }
}

enum Base64URL {
  static func encode(_ data: Data) -> String {
    data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  static func decode(_ value: String) -> Data? {
    guard value.range(of: "^[A-Za-z0-9_-]*$", options: .regularExpression) != nil else { return nil }
    var base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while base64.count % 4 != 0 { base64 += "=" }
    return Data(base64Encoded: base64)
  }
}
