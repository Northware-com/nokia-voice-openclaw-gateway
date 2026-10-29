// Nokia quick-note inbox: accepts a voice clip (audio/ogg) or typed text from the phone,
// transcribes audio through a WhisperX HTTP service and writes a dated Markdown note.
// Requests are idempotent by X-Request-Id so the phone can resend a queued note safely.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { classify, confirmLabel, type Command, type NoteKind } from './commands';
import { renderMeeting, type Segment } from './meeting';
import { readToday } from './today';

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
  meetingsDir?: string;   // meeting audio until its note is written (default: <stateFile dir>/meetings)
  meetingRetryMs?: number; // wait before retrying a meeting while the transcriber is down
};

export type NotesServer = http.Server & { meetingsIdle: () => Promise<void> };

// kind/label/due: what the leading keyword made of the note ("Task saved", "Reminder 15:00").
export type SavedNote = { file: string; summary: string; kind?: NoteKind; label?: string; due?: string };

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

export function stamp(date: Date): { day: string; time: string; iso: string } {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const offset = -date.getTimezoneOffset();
  const zone = (offset >= 0 ? '+' : '-') + pad(Math.floor(Math.abs(offset) / 60)) + ':' + pad(Math.abs(offset) % 60);
  return { day, time, iso: `${day}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${zone}` };
}

function yamlString(value: string): string { return JSON.stringify(value); }

const FILE_PREFIX: Record<NoteKind, string> = {
  note: 'Nokia-Note', task: 'Nokia-Task', idea: 'Nokia-Idea', reminder: 'Nokia-Reminder', meeting: 'Nokia-Meeting',
};
export const MEETING_SEGMENTS_MAX = 600; // ten hours of one-minute segments
const MEETING_SEGMENT_ATTEMPTS = 5;

// Plain notes keep the inbox format; tasks, ideas and reminders get their type, an open
// status and tags so vault queries can find them, and reminders their due time.
export function renderNote(kind: 'voice' | 'text', body: string, summary: string, requestId: string,
  date: Date, transcript?: Transcript, command?: Command): string {
  const when = stamp(date);
  const type = command ? command.kind : 'note';
  const lines = [
    '---',
    `type: ${type}`,
    `status: ${type === 'task' || type === 'reminder' ? 'open' : 'inbox'}`,
    `created: ${when.iso}`,
  ];
  if (command?.kind === 'reminder' && command.due) lines.push(`due: ${stamp(command.due).iso}`);
  if (type !== 'note') lines.push(`tags: [${type}, nokia]`);
  lines.push(
    `source: ${kind === 'voice' ? 'Nokia voice note' : 'Nokia typed note'}`,
    `request_id: ${requestId}`,
  );
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

export function createNotesServer(cfg: NotesConfig, now: () => Date = () => new Date()): NotesServer {
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

  function writeNote(markdown: string, date: Date, kind: NoteKind = 'note'): string {
    const when = stamp(date);
    const prefix = FILE_PREFIX[kind];
    let name = `${prefix}-${when.day}-${when.time}.md`;
    for (let n = 2; fs.existsSync(path.join(cfg.inboxDir, name)); n++) name = `${prefix}-${when.day}-${when.time}-${n}.md`;
    const target = path.join(cfg.inboxDir, name);
    const tmp = path.join(cfg.inboxDir, `.${name}.tmp`);
    fs.writeFileSync(tmp, markdown, { mode: 0o644 });
    fs.renameSync(tmp, target);
    return name;
  }

  // A leading keyword routes the note: tasks, ideas and reminders get their own file type.
  // The keyword itself is dropped; the original wording stays in the body below the title.
  function store(source: 'voice' | 'text', text: string, requestId: string, date: Date, transcript?: Transcript): SavedNote {
    const command = classify(text, date);
    if (command.kind === 'note' || !command.body) {
      const summary = summarize(text);
      return { file: writeNote(renderNote(source, text, summary, requestId, date, transcript), date), summary, kind: 'note', label: 'Note saved' };
    }
    const summary = summarize(command.body);
    const file = writeNote(renderNote(source, text, summary, requestId, date, transcript, command), date, command.kind);
    const note: SavedNote = { file, summary, kind: command.kind, label: confirmLabel(command, date) };
    if (command.due) note.due = stamp(command.due).iso;
    return note;
  }

  async function save(requestId: string, contentType: string, bytes: Buffer): Promise<SavedNote> {
    const date = now();
    let note: SavedNote;
    if (contentType === 'audio/ogg') {
      if (bytes.length < 4 || bytes.subarray(0, 4).toString() !== 'OggS') throw new HttpError(400, 'invalid_ogg');
      const transcript = await transcribe(cfg, bytes);
      if (!transcript.text) throw new HttpError(422, 'no_speech');
      note = store('voice', transcript.text, requestId, date, transcript);
    } else {
      let text: unknown;
      try { text = JSON.parse(bytes.toString('utf8')).text; } catch { throw new HttpError(400, 'invalid_json'); }
      if (typeof text !== 'string' || !text.trim() || text.length > TEXT_LIMIT) throw new HttpError(400, 'invalid_text');
      note = store('text', text, requestId, date);
    }
    remember(requestId, note);
    return note;
  }

  // ── Meetings: segments are stored privately as they arrive; "finish" queues the meeting,
  // which is transcribed segment by segment (each transcript cached, so a transcriber outage
  // only delays it) and written as one note. The audio is deleted once the note exists.
  const meetingsDir = cfg.meetingsDir || path.join(path.dirname(cfg.stateFile), 'meetings');
  fs.mkdirSync(meetingsDir, { recursive: true, mode: 0o700 });
  const meetingJobs = new Map<string, Promise<void>>();
  const retryTimers = new Set<NodeJS.Timeout>();
  const segName = (seq: number): string => `seg-${String(seq).padStart(4, '0')}`;

  function writePrivate(file: string, data: string | Buffer): void {
    fs.writeFileSync(file + '.tmp', data, { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  }

  async function processMeeting(id: string): Promise<void> {
    const dir = path.join(meetingsDir, id);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as
      { requestId: string; segments: number; startedAt: number; durationMs: number; segmentMs: number };
    const segments: Segment[] = [];
    let language: string | undefined;
    const files = fs.readdirSync(dir).filter(f => /^seg-\d{4}\.ogg$/.test(f)).sort();
    for (const f of files) {
      const seq = Number(f.slice(4, 8));
      const cache = path.join(dir, segName(seq) + '.json');
      let part: { text: string; language?: string; failed?: boolean };
      if (fs.existsSync(cache)) part = JSON.parse(fs.readFileSync(cache, 'utf8'));
      else {
        // A segment the transcriber keeps failing on (five attempts) is written up as
        // unreadable rather than holding the whole meeting back forever.
        const errors = path.join(dir, segName(seq) + '.errors');
        try {
          const t = await transcribe(cfg, fs.readFileSync(path.join(dir, f)));
          part = { text: t.text, language: t.language };
        } catch (error) {
          const attempts = (fs.existsSync(errors) ? Number(fs.readFileSync(errors, 'utf8')) || 0 : 0) + 1;
          if (attempts < MEETING_SEGMENT_ATTEMPTS) { writePrivate(errors, String(attempts)); throw error; }
          part = { text: '', failed: true };
        }
        writePrivate(cache, JSON.stringify(part));
      }
      segments.push({ seq, text: part.text, failed: part.failed });
      language = language || part.language;
    }
    const started = new Date(meta.startedAt);
    const { markdown, title } = renderMeeting({
      id, startedIso: stamp(started).iso, durationMs: meta.durationMs, segmentMs: meta.segmentMs,
      expected: Math.max(meta.segments, segments.length ? segments[segments.length - 1].seq : 0), segments, language,
    });
    const file = writeNote(markdown, started, 'meeting');
    const note: SavedNote = { file, summary: title, kind: 'meeting', label: 'Meeting saved' };
    remember(meta.requestId, note);
    remember('meeting:' + id, note);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  function scheduleMeeting(id: string): void {
    if (meetingJobs.has(id)) return;
    const job = processMeeting(id).catch(() => {
      // Transcriber down or a disk error: keep everything and try again later.
      const timer = setTimeout(() => { retryTimers.delete(timer); scheduleMeeting(id); }, cfg.meetingRetryMs ?? 60000);
      retryTimers.add(timer);
    }).finally(() => meetingJobs.delete(id));
    meetingJobs.set(id, job);
  }

  // Meetings finished before a restart resume on start.
  for (const id of fs.readdirSync(meetingsDir)) {
    if (UUID.test(id) && fs.existsSync(path.join(meetingsDir, id, 'meta.json'))) scheduleMeeting(id);
  }

  function meetingDir(id: string): string {
    const dir = path.join(meetingsDir, id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  function saveSegment(id: string, seq: number, bytes: Buffer): { status: number; value: unknown } {
    if (saved['meeting:' + id]) return { status: 200, value: { stored: seq } }; // already written up
    if (bytes.length < 4 || bytes.subarray(0, 4).toString() !== 'OggS') throw new HttpError(400, 'invalid_ogg');
    const file = path.join(meetingDir(id), segName(seq) + '.ogg');
    if (fs.existsSync(file)) return { status: 200, value: { stored: seq } };
    writePrivate(file, bytes);
    return { status: 201, value: { stored: seq } };
  }

  function finishMeeting(id: string, requestId: string, bytes: Buffer): { status: number; value: unknown } {
    const pending = { state: 'processing', kind: 'meeting', label: 'Meeting saved', summary: 'Transcript and summary follow in the inbox' };
    if (saved['meeting:' + id]) return { status: 200, value: saved['meeting:' + id] };
    const metaFile = path.join(meetingsDir, id, 'meta.json');
    if (fs.existsSync(metaFile)) return { status: 202, value: pending };
    let body: { segments?: unknown; startedAt?: unknown; durationMs?: unknown; segmentMs?: unknown };
    try { body = JSON.parse(bytes.toString('utf8')); } catch { throw new HttpError(400, 'invalid_json'); }
    const int = (v: unknown, min: number, max: number): boolean => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
    if (!int(body.segments, 0, MEETING_SEGMENTS_MAX) || !int(body.startedAt, 0, 4e12) ||
        !int(body.durationMs, 0, 36e6) || !int(body.segmentMs, 1000, 600000)) throw new HttpError(400, 'invalid_meeting');
    writePrivate(path.join(meetingDir(id), 'meta.json'), JSON.stringify({
      requestId, segments: body.segments, startedAt: body.startedAt, durationMs: body.durationMs, segmentMs: body.segmentMs,
    }));
    scheduleMeeting(id);
    return { status: 202, value: pending };
  }

  async function handleMeeting(req: http.IncomingMessage, id: string, seq: number | null, requestId: string): Promise<{ status: number; value: unknown }> {
    const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (seq !== null) {
      if (contentType !== 'audio/ogg') throw new HttpError(415, 'unsupported_media_type');
      return saveSegment(id, seq, await readBody(req, AUDIO_LIMIT));
    }
    if (contentType !== 'application/json') throw new HttpError(415, 'unsupported_media_type');
    return finishMeeting(id, requestId, await readBody(req, 1024));
  }

  async function handle(req: http.IncomingMessage): Promise<{ status: number; value: unknown }> {
    if (!tokenMatches(req.headers.authorization, cfg.token)) throw new HttpError(401, 'unauthorized');
    if (req.url === '/health' && req.method === 'GET') return { status: 200, value: { ok: true } };
    if (req.url === '/today' && req.method === 'GET') return { status: 200, value: readToday(cfg.inboxDir, now()) };
    const meeting = /^\/meetings\/([0-9a-f-]{36})\/(?:segments\/(\d{1,4})|finish)$/i.exec(req.url || '');
    if (req.url !== '/notes' && !(meeting && UUID.test(meeting[1]))) throw new HttpError(404, 'not_found');
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
    const requestId = req.headers['x-request-id'];
    if (typeof requestId !== 'string' || !UUID.test(requestId)) throw new HttpError(400, 'uuid_request_id_required');
    if (meeting) {
      const seq = meeting[2] ? Number(meeting[2]) : null;
      if (seq !== null && (seq < 1 || seq > MEETING_SEGMENTS_MAX)) throw new HttpError(404, 'not_found');
      return handleMeeting(req, meeting[1].toLowerCase(), seq, requestId);
    }
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

  const server = http.createServer((req, res) => {
    handle(req).then(
      ({ status, value }) => send(res, status, value),
      (error: unknown) => {
        if (error instanceof HttpError) { send(res, error.status, { error: error.code }); return; }
        console.error('nokia-notes: internal error', error instanceof Error ? error.message : 'unknown');
        send(res, 500, { error: 'internal' });
      },
    );
  }) as NotesServer;
  // Tests and shutdown: wait for meetings being written; closing stops their retries.
  server.meetingsIdle = async (): Promise<void> => { while (meetingJobs.size) await Promise.all([...meetingJobs.values()]); };
  server.on('close', () => { for (const t of retryTimers) clearTimeout(t); retryTimers.clear(); });
  return server;
}

function send(res: http.ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
