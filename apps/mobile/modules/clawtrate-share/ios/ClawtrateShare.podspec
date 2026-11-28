# The iPhone's share sheet for a file a bot handed over (docs/decisions.md, The iOS app).
# Autolinked from apps/mobile/modules.
Pod::Spec.new do |s|
  s.name           = 'ClawtrateShare'
  s.version        = '0.1.0'
  s.summary        = 'The share sheet for one file, which always says when it has closed.'
  s.license        = 'MIT'
  s.author         = 'Clawtrate contributors'
  s.homepage       = 'https://clawtrate.dev'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
