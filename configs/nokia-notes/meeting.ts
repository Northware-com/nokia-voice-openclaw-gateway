// Meeting notes from a long recording sent in segments: a local, extractive summary (no
// language model, no external account) with decisions and action items picked by cue words.

export type Segment = { seq: number; text: string; failed?: boolean };

export type MeetingDigest = {
  summary: string[];    // up to three sentences, in the order they were said
  decisions: string[];
  actions: string[];
  keywords: string[];   // the most repeated content words
};

const STOP = new Set((
  'a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its ' +
  'just like me more my no not now of on one or our out so some that the their them then there these they this to too up ' +
  'us was we were what when where which who will with would yes you your okay ok yeah also very really get got go going ' +
  'think know want need make let lets ' +
  'af alle at blev bliver da de dem den denne der det dig din dine du efter eller en end er et for fra få gør ham han har ' +
  'hun hvad hvis hvor i ikke ind jeg jo kan kun lige man med meget men mig min mine nej noget nok nu når og også om op os ' +
  'over på så sig sin skal som til ud under var vi vil være været ja altså bare godt'
).split(' '));

const DECISION = /\b(?:we(?: have|'ve)? decided|decided|decision|agreed|we agree|let's go with|we'll go with|go ahead with|besluttet|beslutning|beslutter|aftalt|vi aftaler|vi går med|vi vælger)\b/i;
const ACTION = /\b(?:action(?: item)?|to-?do|i'll|we'll|you'll|he'll|she'll|they'll|i will|we will|you will|needs? to|has to|have to|must|should|follow up|by (?:monday|tuesday|wednesday|thursday|friday|tomorrow|next week)|deadline|skal|husk|opgave|følger op|senest|inden)\b/i;

export function sentences(text: string): string[] {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return [];
  return (flat.match(/[^.!?]+(?:[.!?]+|$)/g) || [flat]).map(s => s.trim()).filter(s => /[\p{L}\d]/u.test(s));
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\d']+/u).filter(w => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : text;
}

export function digest(text: string): MeetingDigest {
  const all = sentences(text);
  const freq = new Map<string, number>();
  for (const w of words(text)) freq.set(w, (freq.get(w) || 0) + 1);

  // Sentences scored by how often their content words recur in the whole meeting; short
  // fragments ("Right.") never make the summary.
  const scored = all.map((s, i) => {
    const ws = words(s);
    const score = ws.reduce((sum, w) => sum + (freq.get(w) || 0), 0) / Math.sqrt(Math.max(ws.length, 1));
    return { i, s, score: ws.length >= 4 ? score : -1 };
  });
  const best = scored.filter(x => x.score > 0).sort((a, b) => b.score - a.score || a.i - b.i).slice(0, 3);
  const summary = (best.length ? best : scored.slice(0, 1)).sort((a, b) => a.i - b.i).map(x => clip(x.s, 240));

  const decisions: string[] = [];
  const actions: string[] = [];
  for (const s of all) {
    if (DECISION.test(s)) { if (decisions.length < 8) decisions.push(clip(s, 200)); }
    else if (ACTION.test(s) && actions.length < 12) actions.push(clip(s, 200));
  }
  const keywords = [...freq.entries()].filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6).map(([w]) => w);
  return { summary, decisions, actions, keywords };
}

function mmss(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (h ? h + ':' + pad(m) : String(m)) + ':' + pad(s);
}

export type MeetingInfo = {
  id: string; startedIso: string; durationMs: number; segmentMs: number;
  expected: number; segments: Segment[]; language?: string;
};

// The meeting note: summary, decisions and action items first, then the full transcript
// with a time mark per segment. Missing or silent segments are named, never hidden.
export function renderMeeting(info: MeetingInfo): { markdown: string; title: string } {
  const text = info.segments.map(s => s.text).join(' ');
  const d = digest(text);
  const title = d.summary.length ? clip(d.summary[0], 80) : 'Meeting without speech';
  const got = new Set(info.segments.map(s => s.seq));
  const missing: number[] = [];
  for (let n = 1; n <= info.expected; n++) if (!got.has(n)) missing.push(n);
  const lines = [
    '---',
    'type: meeting',
    'status: inbox',
    `created: ${info.startedIso}`,
    `duration: "${mmss(info.durationMs)}"`,
    `segments: ${info.expected}`,
    'tags: [meeting, nokia]',
    'source: Nokia meeting recording',
    `meeting_id: ${info.id}`,
  ];
  if (info.language) lines.push(`language: ${info.language}`);
  lines.push('transcription: WhisperX (Freyr), unreviewed', 'summary_method: extractive (local, no language model)');
  lines.push(`summary: ${JSON.stringify(title)}`, '---', '', `# Meeting: ${title}`, '');
  lines.push('## Summary', '');
  lines.push(...(d.summary.length ? d.summary.map(s => '- ' + s) : ['- No speech was recognised.']));
  if (d.keywords.length) lines.push('', `Key words: ${d.keywords.join(', ')}`);
  lines.push('', '## Decisions', '');
  lines.push(...(d.decisions.length ? d.decisions.map(s => '- ' + s) : ['- None recognised.']));
  lines.push('', '## Action items', '');
  lines.push(...(d.actions.length ? d.actions.map(s => '- [ ] ' + s) : ['- [ ] None recognised.']));
  lines.push('', '## Transcript', '');
  if (missing.length) lines.push(`> Missing segments: ${missing.join(', ')} (lost before upload).`, '');
  for (const seg of info.segments) {
    lines.push(`**[${mmss((seg.seq - 1) * info.segmentMs)}]** ${seg.text || (seg.failed ? '_(could not be transcribed)_' : '_(no speech)_')}`, '');
  }
  return { markdown: lines.join('\n'), title };
}
