// Entry point: node dist/main.js with NOKIA_NOTES_CONFIG pointing at a private (0600) JSON file:
// {"listen": "192.168.1.10", "port": 8790, "token": "...", "inboxDir": "...", "stateFile": "...",
//  "whisperUrl": "http://freyr:9090"}
import * as fs from 'node:fs';
import { createNotesServer } from './notes';

const file = process.env.NOKIA_NOTES_CONFIG;
if (!file) throw new Error('Set NOKIA_NOTES_CONFIG to the private config file');
if (fs.statSync(file).mode & 0o077) throw new Error('NOKIA_NOTES_CONFIG must be private (0600)');
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
for (const key of ['listen', 'token', 'inboxDir', 'stateFile', 'whisperUrl']) {
  if (typeof config[key] !== 'string' || !config[key]) throw new Error(`Config needs ${key}`);
}
if (!fs.statSync(config.inboxDir).isDirectory()) throw new Error('inboxDir must be an existing directory');
const port = Number(config.port || 8790);
createNotesServer(config).listen(port, config.listen, () => {
  console.error(`nokia-notes listening on ${config.listen}:${port}`);
});
