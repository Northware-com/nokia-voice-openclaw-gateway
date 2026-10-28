#!/usr/bin/env python3
"""Offline credential-packaging boundaries. Uses a fake token; no handset/API access."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'configs/nokia-klaus/build.sh'


class PackagingTests(unittest.TestCase):
    def test_private_build_stays_outside_all_checkouts(self):
        common = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', '--path-format=absolute', '--git-common-dir'], text=True).strip()
        main = Path(common).parent.resolve()
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            config = directory / 'device.json'
            token = 'test_' + 'x' * 40
            config.write_text(json.dumps({'token': token}))
            config.chmod(0o600)
            env = dict(os.environ, NOKIA_BRIDGE_URL='https://example.invalid/nokia/v1', NOKIA_CONFIG_FILE=str(config))
            def build(output):
                return subprocess.run(['sh', str(SCRIPT), str(output)], env=env, capture_output=True, text=True)
            for checkout in {ROOT, main}:
                output = checkout / 'nokia-must-not-exist.zip'
                self.assertFalse(output.exists())
                result = build(output)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(output.exists())
            output = directory / 'private.zip'
            result = build(output)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            self.assertNotIn(token, result.stdout + result.stderr)
            with zipfile.ZipFile(output) as package:
                self.assertEqual(set(package.namelist()), {'manifest.webapp', 'index.html', 'style.css', 'app.js', 'config.js'})
                self.assertIn(token, package.read('config.js').decode())
            config.chmod(0o644)
            rejected = directory / 'rejected.zip'
            self.assertNotEqual(build(rejected).returncode, 0)
            self.assertFalse(rejected.exists())


if __name__ == '__main__':
    unittest.main()
