#!/usr/bin/env python3
"""Reversible development app blocking, not a qualified strict kiosk policy."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import time
import uuid

LAUNCHER = 'app://huginn-nokia-launcher/manifest.webapp'

def stock(names):
    return {f'app://{name}.gaiamobile.org/manifest.webapp' for name in names.split()}

OPTIONAL_MANIFESTS = stock('''calendar camera clock email fm gallery music search video
calculator notes soundrecorder unitconverter filemanager crossyroad dangerdash
dangerdash-premium doodlejump englishwithoxford nitrostreetrun nitrostreetrun-premium
racingroad realfootballrunner realfootballrunner-premium siberianstrike
siberianstrike-premium snake snake-premium''') | {
    'https://api.kaiostech.com/apps/manifest/' + value for value in '''mwkpcuFJhk_Eeema8-fu
TNQNy0nvZdt-jLvokjYJ daR-aFQOTlGk8DJePIQA hY_EHJAESdznRYwwfqsL OSlAbgrhLArfT7grf4_N
RUP-Kznhau9Id7UGc9ck 6x6P4Ap7oCIzOW10hBpm oRD8oeYmeYg4fLIwkQPH ahLsl7Qj6mqlNCaEdKXv
iixJ-quK5BxtInybd7WX'''.split()
} | {'https://www.google.com/maps/preview/pwa/kaios/manifest.webapp',
     'app://huginn-management-probe/manifest.webapp'}
PROTECTED_MANIFESTS = stock('communications contact launcher settings sms stk') | {
    LAUNCHER, 'app://huginn-klaus-audio-proof/manifest.webapp',
}


def classify(app):
    manifest = app.get('manifestURL')
    if not isinstance(manifest, str) or type(app.get('enabled')) is not bool:
        raise ValueError('Inventory requires manifestURL and boolean enabled')
    if app.get('role') in {'system', 'input', 'theme'} or manifest in PROTECTED_MANIFESTS:
        return 'protected'
    return 'optional' if manifest in OPTIONAL_MANIFESTS else 'unknown'


def plan(inventory):
    if not inventory or len({a['manifestURL'] for a in inventory}) != len(inventory):
        raise ValueError('Empty or duplicate inventory')
    unknown = [a['manifestURL'] for a in inventory if classify(a) == 'unknown']
    if unknown:
        raise ValueError('Unknown apps require manual review: ' + ', '.join(unknown))
    return [{'manifestURL': a['manifestURL'], 'before': a['enabled'], 'after': False}
            for a in inventory if classify(a) == 'optional' and a['enabled']]


def validate_snapshot(data):
    if data.get('version') != 2 or not isinstance(data.get('changedTargets'), list):
        raise ValueError('Invalid snapshot version/targets')
    inventory = {a['manifestURL']: a for a in data['inventory']}
    seen = set()
    for target in data['changedTargets']:
        url = target['manifestURL']
        original = inventory.get(url)
        if (url in seen or not original or classify(original) != 'optional'
                or target.get('before') is not True or target.get('after') is not False
                or original['enabled'] is not target['before']):
            raise ValueError('Invalid or unreviewed restore target')
        seen.add(url)
    return data['changedTargets']


def write_snapshot(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(data, stream, indent=2)
        stream.flush()
        os.fsync(stream.fileno())


class Phone:
    def __init__(self, client):
        self.client = client
        actor = client.app(LAUNCHER)
        client.request(actor['actor'], 'attach')
        self.console = actor['consoleActor']

    def evaluate(self, expression):
        result = self.client.request(self.console, 'evaluateJS', text=expression)
        if result.get('exception') or result.get('exceptionMessage'):
            raise RuntimeError('Phone evaluation failed: ' + str(result.get('exceptionMessage')))
        return result.get('result')

    def async_call(self, body):
        token = uuid.uuid4().hex
        # One request, a fresh token, and one result channel per operation.
        self.evaluate('(function(){var token=' + json.dumps(token) + ';'
                      'window.__nokiaPolicy={token:token,done:false};'
                      'function finish(value,error){window.__nokiaPolicy={token:token,done:true,value:value,error:error};}'
                      'try{' + body + '}catch(e){finish(null,String(e));}})();')
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            value = self.evaluate('JSON.stringify(window.__nokiaPolicy)')
            if isinstance(value, str):
                state = json.loads(value)
                if state.get('token') == token and state.get('done'):
                    if state.get('error'):
                        raise RuntimeError(state['error'])
                    return state.get('value')
            time.sleep(0.1)
        raise TimeoutError('Phone callback timed out')

    def inventory(self):
        apps = self.async_call('var r=navigator.mozApps.mgmt.getAll();'
            'r.onerror=function(){finish(null,r.error.name);};'
            'r.onsuccess=function(){finish(r.result.map(function(a){return {'
            'manifestURL:a.manifestURL,enabled:a.enabled,role:a.manifest.role||"",name:a.manifest.name};}),null);};')
        if not isinstance(apps, list) or not apps:
            raise ValueError('Incomplete phone inventory')
        for app in apps:
            classify(app)
        return apps

    def set_enabled(self, manifest, enabled):
        self.async_call('var r=navigator.mozApps.mgmt.getAll();'
            'r.onerror=function(){finish(null,r.error.name);};'
            'r.onsuccess=function(){try{var a=r.result.filter(function(a){return a.manifestURL==='
            + json.dumps(manifest) + ';})[0];if(!a){finish(null,"Missing app");return;}'
            'navigator.mozApps.mgmt.setEnabled(a,' + json.dumps(enabled) + ');finish(true,null);'
            '}catch(e){finish(null,String(e));}};')
        # setEnabled is void, not a DOMRequest. Verify through a fresh inventory.
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            current = {a['manifestURL']: a['enabled'] for a in self.inventory()}
            if current.get(manifest) is enabled:
                return
            time.sleep(0.1)
        raise TimeoutError('Enabled-state readback failed: ' + manifest)

    def launch_result(self, manifest):
        return self.async_call('var r=navigator.mozApps.mgmt.getAll();'
            'r.onerror=function(){finish(null,r.error.name);};'
            'r.onsuccess=function(){try{var a=r.result.filter(function(a){return a.manifestURL==='
            + json.dumps(manifest) + ';})[0];if(!a){finish(null,"Missing app");return;}'
            'var l=a.launch();l.onsuccess=function(){finish("LAUNCHED",null);};'
            'l.onerror=function(){finish(l.error.name,null);};}catch(e){finish(null,String(e));}};')


def apply_targets(phone, targets):
    attempted = []
    try:
        for target in targets:
            attempted.append(target)  # Include a mutation whose acknowledgement might fail.
            phone.set_enabled(target['manifestURL'], target['after'])
    except Exception as cause:
        failures = []
        for target in reversed(attempted):
            try:
                phone.set_enabled(target['manifestURL'], target['before'])
            except Exception as error:
                failures.append(f"{target['manifestURL']}: {error}")
        raise RuntimeError(f'Apply failed: {cause}; rollback failures: {failures}') from cause


def restore_targets(phone, targets):
    failures = []
    for target in targets:
        try:
            phone.set_enabled(target['manifestURL'], target['before'])
        except Exception as error:
            failures.append(f"{target['manifestURL']}: {error}")
    if failures:
        raise RuntimeError(f'Restore failures: {failures}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ('plan', 'apply'):
        sub.add_parser(name).add_argument('--snapshot', type=Path, required=True)
    for name in ('restore', 'verify-blocked'):
        sub.add_parser(name).add_argument('snapshot', type=Path)
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location('nokia_debugger', Path(__file__).with_name('nokia-debugger.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with module.Debugger() as client:
        phone = Phone(client)
        if args.command in ('plan', 'apply'):
            inventory = phone.inventory()
            targets = plan(inventory)
            home = client.request(client.root['settingsActor'], 'getSetting', value='homescreen.manifestURL')['value']
            data = {'version': 2, 'homescreen': home, 'inventory': inventory, 'changedTargets': targets}
            write_snapshot(args.snapshot, data)
            if args.command == 'apply':
                apply_targets(phone, targets)
            print(json.dumps({'snapshot': str(args.snapshot), 'targets': targets}, indent=2))
        else:
            targets = validate_snapshot(json.loads(args.snapshot.read_text()))
            if args.command == 'restore':
                restore_targets(phone, targets)
                print(json.dumps({'restored': len(targets)}))
            else:
                states = {a['manifestURL']: a['enabled'] for a in phone.inventory()}
                if any(states.get(t['manifestURL']) is not False for t in targets):
                    raise RuntimeError('Refusing launch verification: a target is not disabled')
                for target in targets:
                    result = phone.launch_result(target['manifestURL'])
                    if result != 'DISABLED_APP_NOT_LAUNCHABLE':
                        raise RuntimeError(f'Unexpected launch result: {target}: {result}')
                    print(json.dumps({'blocked': target['manifestURL'], 'error': result}), flush=True)


if __name__ == '__main__':
    main()
