#!/usr/bin/env python3
"""USB-only KaiOS debugger client. No firmware or stock-app mutations."""
import argparse
import contextlib
import json
from pathlib import Path
import socket
import subprocess


class Debugger:
    def __enter__(self):
        result = subprocess.run(
            ['adb', '-d', 'forward', 'tcp:0', 'localfilesystem:/data/local/debugger-socket'],
            check=True, capture_output=True, text=True, timeout=10,
        )
        self.port = int(result.stdout)
        try:
            self.sock = socket.create_connection(('127.0.0.1', self.port), timeout=10)
            self.sock.settimeout(20)
            self.buffer = b''
            self.greeting = self.receive()
            self.root = self.request('root', 'listTabs')
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *_):
        if hasattr(self, 'sock'):
            self.sock.close()
        subprocess.run(['adb', 'forward', '--remove', f'tcp:{self.port}'],
                       capture_output=True, timeout=10)

    def receive(self):
        while b':' not in self.buffer:
            self._read()
        length, self.buffer = self.buffer.split(b':', 1)
        size = int(length)
        if size > 32 * 1024 * 1024:
            raise ValueError('Oversized debugger packet')
        while len(self.buffer) < size:
            self._read()
        packet, self.buffer = self.buffer[:size], self.buffer[size:]
        return json.loads(packet)

    def _read(self):
        chunk = self.sock.recv(65536)
        if not chunk:
            raise ConnectionError('Debugger disconnected')
        self.buffer += chunk

    def request(self, actor, kind, **fields):
        packet = json.dumps(dict(to=actor, type=kind, **fields)).encode()
        self.sock.sendall(str(len(packet)).encode() + b':' + packet)
        while True:
            reply = self.receive()
            if reply.get('from') != actor or reply.get('type') in (
                'appOpen', 'appClose', 'appInstall', 'consoleAPICall', 'pageError',
                'networkEvent', 'evaluationResult', 'tabNavigated',
            ):
                continue
            if reply.get('error'):
                raise RuntimeError(json.dumps(reply))
            return reply

    def app(self, manifest):
        return self.request(self.root['webappsActor'], 'getAppActor',
                            manifestURL=manifest)['actor']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('actors')
    sub.add_parser('apps')
    get = sub.add_parser('get-setting')
    get.add_argument('name')
    setting = sub.add_parser('set-setting')
    setting.add_argument('name')
    setting.add_argument('value', help='JSON value; preserve the old value first')
    install = sub.add_parser('install')
    install.add_argument('package', type=Path)
    install.add_argument('--id', required=True, help='Unique removable app ID')
    for name in ('launch', 'close', 'app-actor'):
        action = sub.add_parser(name)
        action.add_argument('manifest')
    evaluate = sub.add_parser('eval')
    evaluate.add_argument('manifest')
    evaluate.add_argument('expression')
    args = parser.parse_args()
    with Debugger() as client:
        webapps = client.root['webappsActor']
        if args.command == 'actors':
            result = client.root
        elif args.command == 'apps':
            result = client.request(webapps, 'getAll')
        elif args.command == 'get-setting':
            result = client.request(client.root['settingsActor'], 'getSetting', value=args.name)
        elif args.command == 'set-setting':
            result = client.request(client.root['settingsActor'], 'setSetting',
                                    name=args.name, value=json.loads(args.value))
        elif args.command == 'install':
            existing = client.request(webapps, 'getAll')['apps']
            if any(app.get('id') == args.id and not app.get('sideloaded') for app in existing):
                raise RuntimeError('Refusing to replace a non-sideloaded app')
            data = args.package.read_bytes()
            if len(data) > 8 * 1024 * 1024:
                raise ValueError('Unexpectedly large package')
            upload = client.request(webapps, 'uploadPackage', bulk=False)['actor']
            try:
                for offset in range(0, len(data), 16384):
                    client.request(upload, 'chunk', chunk=data[offset:offset + 16384].decode('latin1'))
                client.request(upload, 'done')
                result = client.request(webapps, 'install', appId=args.id, upload=upload)
            finally:
                with contextlib.suppress(Exception):
                    client.request(upload, 'remove')
        elif args.command in ('launch', 'close'):
            result = client.request(webapps, args.command, manifestURL=args.manifest)
        elif args.command == 'app-actor':
            result = client.app(args.manifest)
        else:
            actor = client.app(args.manifest)
            client.request(actor['actor'], 'attach')
            result = client.request(actor['consoleActor'], 'evaluateJS', text=args.expression)
        print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
