#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('policy', Path(__file__).parents[1] / 'scripts/nokia-policy.py')
policy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(policy)
SNAKE = 'app://snake.gaiamobile.org/manifest.webapp'


class PolicyTests(unittest.TestCase):
    def app(self, manifest=SNAKE, enabled=True, role=''):
        return dict(manifestURL=manifest, enabled=enabled, role=role, name='test')

    def test_core_and_development_apps_protected(self):
        for url in policy.PROTECTED_MANIFESTS:
            self.assertEqual(policy.classify(self.app(url)), 'protected')
        for role in ('system', 'input', 'theme'):
            self.assertEqual(policy.classify(self.app('app://core', role=role)), 'protected')

    def test_unknown_fails_closed(self):
        with self.assertRaisesRegex(ValueError, 'Unknown apps'):
            policy.plan([self.app('app://unknown')])

    def test_targets_preserve_original_state(self):
        self.assertEqual(policy.plan([self.app()]), [dict(manifestURL=SNAKE, before=True, after=False)])
        self.assertEqual(policy.plan([self.app(enabled=False)]), [])

    def test_invalid_inventory(self):
        for entries in ([], [self.app(), self.app()], [dict(manifestURL=SNAKE)]):
            with self.assertRaises(ValueError):
                policy.plan(entries)

    def test_restore_uses_original_not_requested_state(self):
        calls = []
        class Fake:
            def set_enabled(self, url, enabled): calls.append((url, enabled))
        policy.restore_targets(Fake(), policy.plan([self.app()]))
        self.assertEqual(calls, [(SNAKE, True)])

    def test_restore_continues_after_one_failure(self):
        second = 'app://fm.gaiamobile.org/manifest.webapp'
        calls = []
        class Fake:
            def set_enabled(self, url, enabled):
                calls.append((url, enabled))
                if url == SNAKE: raise TimeoutError('USB acknowledgement lost')
        targets = [dict(manifestURL=url, before=True, after=False) for url in (SNAKE, second)]
        with self.assertRaisesRegex(RuntimeError, 'Restore failures:.*snake'):
            policy.restore_targets(Fake(), targets)
        self.assertEqual(calls, [(SNAKE, True), (second, True)])

    def test_partial_failure_restores_uncertain_write_too(self):
        calls = []
        class Fake:
            def set_enabled(self, url, enabled):
                calls.append((url, enabled))
                if not enabled: raise TimeoutError('ack lost after mutation')
        with self.assertRaisesRegex(RuntimeError, r'rollback failures: \[\]'):
            policy.apply_targets(Fake(), policy.plan([self.app()]))
        self.assertEqual(calls, [(SNAKE, False), (SNAKE, True)])

    def test_snapshot_validation(self):
        data = dict(version=2, inventory=[self.app()], changedTargets=policy.plan([self.app()]))
        self.assertEqual(policy.validate_snapshot(data)[0]['before'], True)
        data['changedTargets'][0]['before'] = False
        with self.assertRaises(ValueError): policy.validate_snapshot(data)

    def test_private_exclusive_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory) / 'before.json'
            policy.write_snapshot(p, {'version': 2})
            self.assertEqual(p.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError): policy.write_snapshot(p, {})

    def test_console_returns_primitive_string(self):
        class Client:
            def app(self, _): return dict(actor='app', consoleActor='console')
            def request(self, actor, kind, **kwargs):
                return dict(result='plain string') if kind == 'evaluateJS' else {}
        self.assertEqual(policy.Phone(Client()).evaluate('x'), 'plain string')

    def test_eval_exception_is_failure(self):
        class Client:
            def app(self, _): return dict(actor='app', consoleActor='console')
            def request(self, actor, kind, **kwargs):
                return dict(exception={'type': 'object'}, exceptionMessage='error') if kind == 'evaluateJS' else {}
        with self.assertRaises(RuntimeError): policy.Phone(Client()).evaluate('x')


if __name__ == '__main__':
    unittest.main()
