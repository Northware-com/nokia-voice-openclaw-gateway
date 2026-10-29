// Nokia quick-note inbox: accepts a voice clip (audio/ogg) or typed text from the phone,
// transcribes audio through a WhisperX HTTP service and writes a dated Markdown note.
// Requests are idempotent by X-Request-Id so the phone can resend a queued note safely.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

export const AUDIO_LIMIT = 5 * 1024 * 1024;
export const TEXT_LIMIT = 4000;
const MAX_REMEMBERED = 2048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type NotesConfig = {
  token: string;          // bearer the phone sends; never logged
  inboxDir: string;       // directory receiving the Markdown notes
  stateFile: string;      // request id -> saved note, for idempotent resends
  whisperUrl: string;     // e.g. http://freyr:9090 (POST /transcribe, multipart "file")
  transcribeTimeoutMs?: number;
};

export type SavedNote = { file: string; summary: string };

type Transcript = { text: string; language?: string; duration?: number };

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

// One line for the phone: the first sentence, at most 80 characters.
export function summarize(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const sentence = (flat.match(/^.*?[.!?](?=\s|$)/) || [flat])[0];
  return sentence.length > 80 ? sentence.slice(0, 79).trimEnd() + '…' : sentence;
}

function stamp(date: Date): { day: string; time: string; iso: string } {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const offset = -date.getTimezoneOffset();
  const zone = (offset >= 0 ? '+' : '-') + pad(Math.floor(Math.abs(offset) / 60)) + ':' + pad(Math.abs(offset) % 60);
  return { day, time, iso: `${day}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${zone}` };
}

function yamlString(value: string): string { return JSON.stringify(value); }

export function renderNote(kind: 'voice' | 'text', body: string, summary: string, requestId: string,
  date: Date, transcript?: Transcript): string {
  const when = stamp(date);
  const lines = [
    '---',
    'type: note',
    'status: inbox',
    `created: ${when.iso}`,
    `source: ${kind === 'voice' ? 'Nokia voice note' : 'Nokia typed note'}`,
    `request_id: ${requestId}`,
  ];
  if (transcript?.language) lines.push(`language: ${transcript.language}`);
  if (typeof transcript?.duration === 'number') lines.push(`duration_s: ${Math.round(transcript.duration * 10) / 10}`);
  if (kind === 'voice') lines.push('transcription: WhisperX (Freyr), unreviewed');
  lines.push(`summary: ${yamlString(summary)}`, '---', '', `# ${summary}`, '', body.trim(), '');
  return lines.join('\n');
}

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { reject(new HttpError(413, 'too_large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const given = Buffer.from(/^Bearer (.+)$/.exec(header || '')?.[1] || '');
  const want = Buffer.from(token);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

async function transcribe(cfg: NotesConfig, audio: Buffer): Promise<Transcript> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/ogg' }), 'note.ogg');
  let res: Response;
  try {
    res = await fetch(cfg.whisperUrl.replace(/\/$/, '') + '/transcribe', {
      method: 'POST', body: form, signal: AbortSignal.timeout(cfg.transcribeTimeoutMs ?? 120000),
    });
  } catch {
    throw new HttpError(503, 'transcriber_unreachable');
  }
  if (res.status !== 200) throw new HttpError(503, 'transcriber_error');
  const value = await res.json() as { text?: unknown; language?: unknown; duration_s?: unknown };
  if (typeof value.text !== 'string') throw new HttpError(503, 'transcriber_error');
  return {
    text: value.text.trim(),
    language: typeof value.language === 'string' ? value.language : undefined,
    duration: typeof value.duration_s === 'number' ? value.duration_s : undefined,
  };
}

export function createNotesServer(cfg: NotesConfig, now: () => Date = () => new Date()): http.Server {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(cfg.token)) throw new Error('Notes token must be 32-128 URL-safe characters');
  let saved: Record<string, SavedNote> = {};
  try { saved = JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8')); } catch { /* first run */ }
  const inFlight = new Map<string, Promise<SavedNote>>();

  function remember(requestId: string, note: SavedNote): void {
    saved[requestId] = note;
    const ids = Object.keys(saved);
    for (let i = 0; i < ids.length - MAX_REMEMBERED; i++) delete saved[ids[i]];
    const tmp = cfg.stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(saved), { mode: 0o600 });
    fs.renameSync(tmp, cfg.stateFile);
  }

  function writeNote(markdown: string, date: Date): string {
    const when = stamp(date);
    let name = `Nokia-Note-${when.day}-${when.time}.md`;
    for (let n = 2; fs.existsSync(path.join(cfg.inboxDir, name)); n++) name = `Nokia-Note-${when.day}-${when.time}-${n}.md`;
    const target = path.join(cfg.inboxDir, name);
    const tmp = path.join(cfg.inboxDir, `.${name}.tmp`);
    fs.writeFileSync(tmp, markdown, { mode: 0o644 });
    fs.renameSync(tmp, target);
    return name;
  }

  async function save(requestId: string, contentType: string, bytes: Buffer): Promise<SavedNote> {
    const date = now();
    let note: SavedNote;
    if (contentType === 'audio/ogg') {
      if (bytes.length < 4 || bytes.subarray(0, 4).toString() !== 'OggS') throw new HttpError(400, 'invalid_ogg');
      const transcript = await transcribe(cfg, bytes);
      if (!transcript.text) throw new HttpError(422, 'no_speech');
      const summary = summarize(transcript.text);
      note = { file: writeNote(renderNote('voice', transcript.text, summary, requestId, date, transcript), date), summary };
    } else {
      let text: unknown;
      try { text = JSON.parse(bytes.toString('utf8')).text; } catch { throw new HttpError(400, 'invalid_json'); }
      if (typeof text !== 'string' || !text.trim() || text.length > TEXT_LIMIT) throw new HttpError(400, 'invalid_text');
      const summary = summarize(text);
      note = { file: writeNote(renderNote('text', text, summary, requestId, date), date), summary };
    }
    remember(requestId, note);
    return note;
  }

  async function handle(req: http.IncomingMessage): Promise<{ status: number; value: unknown }> {
    if (!tokenMatches(req.headers.authorization, cfg.token)) throw new HttpError(401, 'unauthorized');
    if (req.url === '/health' && req.method === 'GET') return { status: 200, value: { ok: true } };
    if (req.url !== '/notes') throw new HttpError(404, 'not_found');
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
    const requestId = req.headers['x-request-id'];
    if (typeof requestId !== 'string' || !UUID.test(requestId)) throw new HttpError(400, 'uuid_request_id_required');
    const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'audio/ogg' && contentType !== 'application/json') throw new HttpError(415, 'unsupported_media_type');
    const bytes = await readBody(req, contentType === 'audio/ogg' ? AUDIO_LIMIT : TEXT_LIMIT * 4 + 128);
    if (saved[requestId]) return { status: 200, value: saved[requestId] };
    let pending = inFlight.get(requestId);
    if (!pending) {
      pending = save(requestId, contentType, bytes).finally(() => inFlight.delete(requestId));
      inFlight.set(requestId, pending);
    }
    return { status: 201, value: await pending };
  }

  return http.createServer((req, res) => {
    handle(req).then(
      ({ status, value }) => send(res, status, value),
      (error: unknown) => {
        if (error instanceof HttpError) { send(res, error.status, { error: error.code }); return; }
        console.error('nokia-notes: internal error', error instanceof Error ? error.message : 'unknown');
        send(res, 500, { error: 'internal' });
      },
    );
  });
}

function send(res: http.ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
