#!/usr/bin/env python3
"""Record source, native binary, fixture and image provenance after validation."""
import hashlib
import json
import plistlib
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parents[1]
repo = Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip())
source = 'bb04869f1ae2f7478b2c5ecc6464ac0d2c5c1dfd'
app = Path(sys.argv[1])
info = plistlib.loads((app / 'Info.plist').read_bytes())

def sha(data):
    return hashlib.sha256(data).hexdigest()

def git(*args):
    return subprocess.check_output(['git', *args], cwd=repo)

devices = {
    'iphone': {'model': 'iPhone 18 Pro Max', 'runtime': 'iOS 27.0', 'udid': '971EBFFD-9D7F-44C9-B16F-F936C44EF05F'},
    'ipad': {'model': 'iPad Pro 13-inch (M5)', 'runtime': 'iOS 27.0', 'udid': '717A7314-6643-46F9-A8D4-4ED4B28530C7'},
    'duo-outer': {'model': 'iPhone Duo', 'runtime': 'iOS 27.1', 'udid': '236ACA1C-9015-4880-8520-15F755AC3110'},
}
images = []
for path in sorted(root.rglob('*.png')):
    with Image.open(path) as image:
        image.load()
        assert image.mode == 'RGB', path
        width, height = image.size
    record = json.loads(path.with_suffix('.capture.json').read_text())
    assert record['sha256'] == sha(path.read_bytes()), path
    family = path.parent.name if 'en-US' in path.parts else 'layout-evidence'
    images.append({**record, 'file': str(path.relative_to(root)), 'width': width, 'height': height,
                   'role': 'upload-candidate' if family in devices else 'layout-evidence',
                   'appearance': 'dark' if path.name.startswith('06-') else 'light',
                   'fixture': 'sample-conversations-v1', 'deviceFamily': family})
fixture = root / 'fixtures/sample-conversations.json'
paths = git('diff-tree', '--no-commit-id', '--name-only', '-r', source).decode().splitlines()
manifest = {
    'schemaVersion': 1, 'generatedAtUTC': datetime.now(timezone.utc).isoformat(),
    'app': {'name': 'AI Chat on My Terms', 'bundleIdentifier': info['CFBundleIdentifier'], 'version': info['CFBundleShortVersionString']},
    'source': {'commit': source, 'diffSHA256': sha(git('diff', source + '^', source, '--')),
               'diffDefinition': 'git diff <source>^ <source> --',
               'changedFilesAtCheckpoint': {p: sha(git('show', f'{source}:{p}')) for p in paths},
               'productionOnlyDifference': 'apps/mobile/app.json automatic buildNumber increment from 29 to 32; no subsequent UI change',
               'matchesHistoricalProductionBuild23': False},
    'simulatorBinary': {'configuration': 'Release', 'build': info['CFBundleVersion'], 'sdk': info['DTSDKName'],
                         'xcodeBuild': info['DTXcodeBuild'], 'javaScriptEmbedded': True, 'metroRequired': False,
                         'mainJSBundleSHA256': sha((app / 'main.jsbundle').read_bytes()),
                         'executableSHA256': sha((app / info['CFBundleExecutable']).read_bytes())},
    'storeArtifact': {'build': '32', 'platform': 'iphoneos', 'sha256': 'f0e53f5ea72f40d57bd82d5e5bd372b7adbbd2ceb0d44aadb0311e7ac6937aa1',
                      'record': '../../../docs/builds/ios-production-32.md', 'appleUploadVerified': False,
                      'note': 'Separate signed artifact; Apple requested secure app-specific-password authentication.'},
    'devices': devices,
    'fixtures': [{'id': 'sample-conversations-v1', 'file': str(fixture.relative_to(root)), 'sha256': sha(fixture.read_bytes()),
                  'fictional': True, 'importMethod': 'Normal Import LM Studio export flow and native system document picker on all three simulators'}],
    'images': images,
    'validation': {'uploadCandidateCount': 18, 'imagesDecoded': True, 'opaqueRGB': True,
                   'uniqueWithinEachUploadSet': True, 'fullNativeFrame': True,
                   'pixelTransform': 'Only removal of entirely opaque alpha channel; RGB unchanged',
                   'dimensionsReference': 'https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/',
                   'dimensionsVerifiedDate': '2026-10-23',
                   'acceptedPortraitDimensions': {'iphone': [1320, 2868], 'ipad': [2064, 2752], 'duo-outer': [1398, 2034]},
                   'visualReview': 'Each upload image inspected individually and in contact sheets; evidence kept separate'},
    'verificationReports': [str(p.relative_to(root)) for p in sorted(root.glob('evidence/**/*verification.json'))],
    'limits': ['No screenshot uploaded to Apple', 'TestFlight upload/processing/install availability not verified',
               'No physical-device inference or provider-connectivity acceptance', 'No App Review submission or public release'],
}
receipt_path = root / 'apple-upload-receipt.json'
if receipt_path.exists():
    receipt = json.loads(receipt_path.read_text())
    manifest['appleDelivery'] = {
        'receipt': receipt_path.name,
        'verifiedAtUTC': receipt['verifiedAtUTC'],
        'totalScreenshots': receipt['totalScreenshots'],
        'allProcessingVerified': receipt['allProcessingVerified'],
        'appStoreState': receipt['appStoreState'],
    }
    manifest['storeArtifact']['appleUploadVerified'] = True
    manifest['storeArtifact']['processingState'] = receipt['build32'][0]['processingState']
    manifest['storeArtifact']['internalTestFlightState'] = receipt['build32'][0]['internalState']
    manifest['storeArtifact']['note'] = 'Apple accepted and processed the signed artifact; export-compliance declaration remains missing.'
    manifest['limits'] = [
        'TestFlight install availability blocked by missing export compliance',
        'No physical-device inference or provider-connectivity acceptance',
        'No App Review submission or public release',
    ]
owner_path = repo / 'docs/builds/ios-production-32-owner-testflight.json'
if owner_path.exists():
    owner = json.loads(owner_path.read_text())
    assert owner['build'] == manifest['storeArtifact']['build']
    manifest['storeArtifact']['internalTestFlightState'] = owner['internalState']
    manifest['storeArtifact']['usesNonExemptEncryption'] = owner['usesNonExemptEncryption']
    manifest['storeArtifact']['ownerGroup'] = owner['ownerGroup']
    manifest['storeArtifact']['ownerTestFlightReceipt'] = '../../../docs/builds/' + owner_path.name
    manifest['storeArtifact']['note'] = 'Apple state IN_BETA_TESTING; assigned to internal Owner group with owner tester; build-specific OS-encryption exemption assessed and accepted.'
    manifest['limits'] = [
        'Physical TestFlight installation not yet verified',
        'No physical-device inference or provider-connectivity acceptance',
        'No App Review submission or public release',
    ]
(root / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(f'Recorded {len(images)} native images; 18 upload candidates')
