// Today view for the phone: reminders due today (and open overdue ones) plus the latest notes,
// tasks, ideas and meetings, read back from the Nokia-* files in the inbox. Read-only; a file
// moved out of the inbox or marked anything but "open" no longer shows.
import * as fs from 'node:fs';
import * as path from 'node:path';

export type TodayReminder = { due: string | null; text: string; overdue: boolean };
export type TodayItem = { kind: string; summary: string; created: string };
export type Today = {
  date: string;
  reminders: TodayReminder[];
  undated: number;          // open reminders without a time
  latest: TodayItem[];
  calendar: null;           // not connected (no calendar credentials on the notes service)
  mail: null;               // not connected
};

const FILE = /^Nokia-(Note|Task|Idea|Reminder|Meeting)-\d{4}-\d{2}-\d{2}-\d{6}(?:-\d+)?\.md$/;
const SCAN_LIMIT = 400;  // newest files looked at
const LATEST = 6;
const HEAD_BYTES = 2048; // front matter only

type Front = Record<string, string>;

export function frontMatter(text: string): Front {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  const out: Front = {};
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value.startsWith('"')) { try { value = JSON.parse(value); } catch { /* keep raw */ } }
    out[kv[1]] = value;
  }
  return out;
}

function head(file: string): string {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    return buf.subarray(0, fs.readSync(fd, buf, 0, HEAD_BYTES, 0)).toString('utf8');
  } finally { fs.closeSync(fd); }
}

function dayOf(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function readToday(inboxDir: string, now: Date): Today {
  // File names sort by kind then time; sort by the timestamp part to get the newest.
  const stampOf = (f: string): string => f.replace(/^Nokia-[A-Za-z]+-/, '');
  const files = fs.readdirSync(inboxDir).filter(f => FILE.test(f))
    .sort((a, b) => stampOf(b).localeCompare(stampOf(a))).slice(0, SCAN_LIMIT);
  const today = dayOf(now);
  const reminders: TodayReminder[] = [];
  const latest: TodayItem[] = [];
  let undated = 0;
  for (const f of files) {
    let fm: Front;
    try { fm = frontMatter(head(path.join(inboxDir, f))); } catch { continue; }
    const type = fm.type || 'note';
    if (type === 'reminder') {
      if (fm.status !== 'open') continue;
      if (!fm.due) { undated++; continue; }
      const due = new Date(fm.due);
      if (Number.isNaN(due.getTime())) continue;
      const day = dayOf(due);
      if (day === today || (day < today)) reminders.push({ due: fm.due, text: fm.summary || '', overdue: day < today });
      continue;
    }
    if (latest.length < LATEST) latest.push({ kind: type, summary: fm.summary || '', created: fm.created || '' });
  }
  reminders.sort((a, b) => String(a.due).localeCompare(String(b.due)));
  return { date: today, reminders: reminders.slice(-12), undated, latest, calendar: null, mail: null };
}
