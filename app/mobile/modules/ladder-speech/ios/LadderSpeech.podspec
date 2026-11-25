Pod::Spec.new do |s|
  s.name = 'LadderSpeech'
  s.version = '1.0.0'
  s.summary = 'On-device dictation for Ladder (SpeechAnalyzer, iOS 26).'
  s.author = 'Ladder'
  s.homepage = 'https://github.com/'
  s.platform = :ios, '15.1'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
  s.frameworks = 'AVFoundation', 'Speech'
end
