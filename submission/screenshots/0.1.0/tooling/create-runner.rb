#!/usr/bin/env ruby
require 'xcodeproj'
require 'fileutils'
source, destination = ARGV
abort 'Usage: create-runner.rb <CaptureUITests.swift> <temporary-project-directory>' unless destination
FileUtils.mkdir_p(destination)
FileUtils.cp(source, File.join(destination, 'CaptureUITests.swift'))
project = Xcodeproj::Project.new(File.join(destination, 'Capture.xcodeproj'))
target = project.new_target(:ui_test_bundle, 'CaptureUITests', :ios, '17.0')
target.add_file_references([project.main_group.new_file('CaptureUITests.swift')])
target.build_configurations.each do |config|
  config.build_settings.merge!({
    'PRODUCT_BUNDLE_IDENTIFIER' => 'com.locallab.capture',
    'GENERATE_INFOPLIST_FILE' => 'YES',
    'SWIFT_VERSION' => '5.0',
    'CODE_SIGNING_ALLOWED' => 'NO',
    'TARGETED_DEVICE_FAMILY' => '1,2',
    'SDKROOT' => 'iphonesimulator'
  })
end
scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(target)
scheme.add_test_target(target)
scheme.save_as(project.path, 'CaptureUITests')
project.save
