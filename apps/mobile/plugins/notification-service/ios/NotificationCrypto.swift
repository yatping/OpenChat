import CryptoKit
import Foundation

/// Opens a notification sealed by the installation (ADR-0017). It repeats, step for step,
/// packages/notification-protocol/src/notification-crypto.ts: HPKE (RFC 9180) base mode, DHKEM(X25519, HKDF-SHA256),
/// HKDF-SHA256, AES-128-GCM. Checked against the RFC's test vector by scripts/check-notification-crypto.sh.
struct OpenedNotification: Equatable {
  let title: String
  let sender: String
  let text: String
}

enum NotificationCrypto {
  enum Failure: Error {
    case malformed
    case lowOrderPoint
  }

  static let info = Data("OpenChat notification v1".utf8)
  static let plaintextBytes = 256
  static let sealedBytes = 32 + plaintextBytes + 16

  private static let version = Data("HPKE-v1".utf8)
  private static let kemSuite = Data("KEM".utf8) + i2osp(0x0020, 2)
  private static let hpkeSuite = Data("HPKE".utf8) + i2osp(0x0020, 2) + i2osp(0x0001, 2) + i2osp(0x0001, 2)

  /// `oc` is the custom key of the APNs payload. Throws on anything unexpected; the caller then shows the fallback.
  static func open(oc: [AnyHashable: Any], key: (String) -> Curve25519.KeyAgreement.PrivateKey?) throws -> OpenedNotification {
    guard
      let installationId = oc["installationId"] as? String,
      let workspaceId = oc["workspaceId"] as? String,
      let notificationId = oc["notificationId"] as? String,
      let subscriptionId = oc["subscriptionId"] as? String,
      let sealedText = oc["c"] as? String,
      let sealed = Base64URL.decode(sealedText), sealed.count == sealedBytes,
      let recipient = key(subscriptionId)
    else { throw Failure.malformed }
    let ids = [installationId, workspaceId, notificationId, subscriptionId]
    guard ids.allSatisfy({ !$0.isEmpty && !$0.contains("\n") }) else { throw Failure.malformed }
    let aad = Data((["OCN1"] + ids).joined(separator: "\n").utf8)
    let padded = try hpkeOpenBase(recipient: recipient, enc: Data(sealed.prefix(32)), info: info, aad: aad, ciphertext: Data(sealed.dropFirst(32)))
    return try unpad(padded)
  }

  static func hpkeOpenBase(recipient: Curve25519.KeyAgreement.PrivateKey, enc: Data, info: Data, aad: Data, ciphertext: Data) throws -> Data {
    guard enc.count == 32, ciphertext.count >= 16 else { throw Failure.malformed }
    let ephemeral = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: enc)
    let dh = try recipient.sharedSecretFromKeyAgreement(with: ephemeral).withUnsafeBytes { Data($0) }
    guard dh.contains(where: { $0 != 0 }) else { throw Failure.lowOrderPoint }
    let kemContext = enc + recipient.publicKey.rawRepresentation
    let eaePrk = labeledExtract(kemSuite, salt: Data(), label: "eae_prk", ikm: dh)
    let sharedSecret = labeledExpand(kemSuite, prk: eaePrk, label: "shared_secret", info: kemContext, length: 32)

    let pskIdHash = labeledExtract(hpkeSuite, salt: Data(), label: "psk_id_hash", ikm: Data())
    let infoHash = labeledExtract(hpkeSuite, salt: Data(), label: "info_hash", ikm: info)
    let context = Data([0]) + pskIdHash + infoHash
    let secret = labeledExtract(hpkeSuite, salt: sharedSecret, label: "secret", ikm: Data())
    let key = labeledExpand(hpkeSuite, prk: secret, label: "key", info: context, length: 16)
    let nonce = labeledExpand(hpkeSuite, prk: secret, label: "base_nonce", info: context, length: 12)

    let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: ciphertext.dropLast(16), tag: ciphertext.suffix(16))
    return try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad)
  }

  static func unpad(_ padded: Data) throws -> OpenedNotification {
    let bytes = [UInt8](padded)
    guard bytes.count == plaintextBytes else { throw Failure.malformed }
    let length = Int(bytes[0]) << 8 | Int(bytes[1])
    guard length <= plaintextBytes - 2, bytes[(2 + length)...].allSatisfy({ $0 == 0 }) else { throw Failure.malformed }
    guard
      let object = try JSONSerialization.jsonObject(with: Data(bytes[2..<(2 + length)])) as? [String: Any],
      object["v"] as? Int == 1,
      let title = object["title"] as? String,
      let sender = object["sender"] as? String,
      let text = object["text"] as? String
    else { throw Failure.malformed }
    return OpenedNotification(title: title, sender: sender, text: text)
  }

  private static func i2osp(_ value: Int, _ length: Int) -> Data {
    Data((0..<length).reversed().map { UInt8((value >> ($0 * 8)) & 0xff) })
  }

  /// An empty HMAC key equals a key of zeros, which is what HKDF uses for an empty salt.
  private static func hmac(key: Data, data: Data) -> Data {
    Data(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key.isEmpty ? Data(count: 32) : key)))
  }

  private static func labeledExtract(_ suite: Data, salt: Data, label: String, ikm: Data) -> Data {
    hmac(key: salt, data: version + suite + Data(label.utf8) + ikm)
  }

  private static func labeledExpand(_ suite: Data, prk: Data, label: String, info: Data, length: Int) -> Data {
    let labeled = i2osp(length, 2) + version + suite + Data(label.utf8) + info
    var out = Data()
    var block = Data()
    var counter: UInt8 = 1
    while out.count < length {
      block = hmac(key: prk, data: block + labeled + Data([counter]))
      out += block
      counter += 1
    }
    return out.prefix(length)
  }
}
