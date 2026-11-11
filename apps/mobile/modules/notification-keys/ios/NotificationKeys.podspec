Pod::Spec.new do |s|
  s.name           = 'NotificationKeys'
  s.version        = '1.0.0'
  s.summary        = 'Keys for encrypted notifications (ADR-0017)'
  s.description    = 'Makes and keeps the X25519 key each push subscription is encrypted to, in the keychain the notification extension shares.'
  s.author         = 'OpenChat'
  s.homepage       = 'https://github.com/yatping/OpenChat'
  s.license        = 'Apache-2.0'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
end
