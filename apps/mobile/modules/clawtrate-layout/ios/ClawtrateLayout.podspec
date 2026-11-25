# The app's own native module: what UIKit says about the window's shape
# (docs/decisions.md, The iOS app). Autolinked from apps/mobile/modules.
Pod::Spec.new do |s|
  s.name           = 'ClawtrateLayout'
  s.version        = '0.1.0'
  s.summary        = 'The window geometry the Clawtrate iPhone app lays out by.'
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
