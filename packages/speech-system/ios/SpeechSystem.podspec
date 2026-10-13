Pod::Spec.new do |s|
  s.name           = 'SpeechSystem'
  s.version        = '0.1.0'
  s.summary        = 'LocalLab iOS system speech recognition bridge'
  s.description    = 'Expo native module scaffold bridging Apple Speech recognition to the shared SpeechInputPort.'
  s.license        = { :type => 'MIT' }
  s.author         = 'LocalLab'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '17.0' }
  s.swift_version  = '5.9'
  s.source         = { :git => '' }
  s.static_framework = true
  s.source_files   = '*.swift'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.dependency 'ExpoModulesCore'
end
