// Checks the extension's decryption against RFC 9180 A.1.1 and against a notification sealed by the TypeScript
// side. Run by ../check-notification-crypto.sh, on a Mac, since CryptoKit is Apple's.
import CryptoKit
import Foundation

func hex(_ value: String) -> Data {
  var data = Data()
  var index = value.startIndex
  while index < value.endIndex {
    let next = value.index(index, offsetBy: 2)
    data.append(UInt8(value[index..<next], radix: 16)!)
    index = next
  }
  return data
}

var failures = 0
func check(_ name: String, _ passed: Bool) {
  print("\(passed ? "ok  " : "FAIL") \(name)")
  if !passed { failures += 1 }
}

// RFC 9180, Appendix A.1.1.
let skRm = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex("4612c550263fc8ad58375df3f557aac531d26850903e55a9f23f21d8534e8ac8"))
let opened = try? NotificationCrypto.hpkeOpenBase(
  recipient: skRm,
  enc: hex("37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431"),
  info: hex("4f6465206f6e2061204772656369616e2055726e"),
  aad: hex("436f756e742d30"),
  ciphertext: hex("f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a")
)
check("RFC 9180 A.1.1 opens to the published plaintext", opened == hex("4265617574792069732074727574682c20747275746820626561757479"))
check("RFC 9180 A.1.1 refuses other associated data", (try? NotificationCrypto.hpkeOpenBase(recipient: skRm, enc: hex("37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431"), info: hex("4f6465206f6e2061204772656369616e2055726e"), aad: hex("436f756e742d31"), ciphertext: hex("f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a"))) == nil)

// The vector sealed by packages/notification-protocol.
let path = CommandLine.arguments[1]
let vector = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as! [String: Any]
let phone = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: Base64URL.decode(vector["privateKeyRaw"] as! String)!)
check("the key's public half matches", Base64URL.encode(phone.publicKey.rawRepresentation) == vector["publicKey"] as! String)
let binding = vector["binding"] as! [String: String]
var oc: [AnyHashable: Any] = binding
oc["c"] = vector["sealed"]
let content = vector["content"] as! [String: Any]
let expected = OpenedNotification(title: content["title"] as! String, sender: content["sender"] as! String, text: content["text"] as! String)
check("opens what the installation sealed", (try? NotificationCrypto.open(oc: oc, key: { $0 == binding["subscriptionId"] ? phone : nil })) == expected)
for field in ["installationId", "workspaceId", "notificationId"] {
  var moved = oc
  moved[field] = "other"
  check("refuses it moved to another \(field)", (try? NotificationCrypto.open(oc: moved, key: { _ in phone })) == nil)
}
check("refuses it for another phone", (try? NotificationCrypto.open(oc: oc, key: { _ in Curve25519.KeyAgreement.PrivateKey() })) == nil)
var cut = oc
cut["c"] = String((oc["c"] as! String).dropLast(4))
check("refuses it resized", (try? NotificationCrypto.open(oc: cut, key: { _ in phone })) == nil)

exit(failures == 0 ? 0 : 1)
