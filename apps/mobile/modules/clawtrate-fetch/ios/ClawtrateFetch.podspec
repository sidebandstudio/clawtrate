# The iPhone host's HTTP GET for the pictures core reads from the gateway
# (docs/decisions.md, The iOS app). Autolinked from apps/mobile/modules.
Pod::Spec.new do |s|
  s.name           = 'ClawtrateFetch'
  s.version        = '0.1.0'
  s.summary        = 'An HTTP GET with no cache, no cookies, no stored credentials and no redirects.'
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
