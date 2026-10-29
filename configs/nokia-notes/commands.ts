// Spoken or typed commands at the start of a note: "task …", "idea …", "remind me … at 15:00",
// and the Danish "opgave …", "idé …", "husk … kl. 15". Pure functions; the clock is passed in.

// meeting: written by the meeting recorder (meeting.ts), never by a keyword.
export type NoteKind = 'note' | 'task' | 'idea' | 'reminder' | 'meeting';

export type Command = {
  kind: NoteKind;
  body: string;   // the note without its keyword (and, for reminders, without the time words)
  due?: Date;     // reminders with a recognised time
};

// Keyword, then a separator ("Task: …", "Task, …", "task …"). Lookaheads instead of \b
// because \b does not see "é" as a word character.
const END = '(?=[\\s,.:;!?-]|$)[\\s,.:;!?-]*';
const TASK = new RegExp(`^(?:new\\s+task|task|to-?do|ny\\s+opgave|opgave)${END}`, 'i');
const IDEA = new RegExp(`^(?:new\\s+idea|idea|ny\\s+id[eé]|id[eé])${END}`, 'i');
const REMIND = new RegExp(
  `^(?:remind\\s+me(?:\\s+(?:to|that|about))?|reminder|husk\\s+mig\\s+(?:på|om)(?:\\s+at)?|husk(?:\\s+at)?|påmind\\s+mig(?:\\s+om)?)${END}`, 'i');

const NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, en: 1, et: 1, two: 2, to: 2, three: 3, tre: 3, half: 0.5 };
const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  søndag: 0, mandag: 1, tirsdag: 2, onsdag: 3, torsdag: 4, fredag: 5, lørdag: 6,
};

function tidy(text: string): string {
  const t = text.replace(/\s+/g, ' ').replace(/\s+([,.!?])/g, '$1').replace(/^[\s,.:;!?-]+|[\s,:;-]+$/g, '')
    .replace(/^(?:to|at|that|about|om)\s+/i, '');
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}

// Find a time in a reminder and return the due date plus the text without the time words.
export function parseWhen(text: string, now: Date): { due?: Date; rest: string } {
  let rest = ' ' + text + ' ';
  const cut = (m: RegExpExecArray): void => { rest = rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length); };
  const B = '(?<![\\p{L}\\d])';
  const A = '(?![\\p{L}\\d])';

  // "in 20 minutes", "in an hour", "om 2 timer", "om en halv time"
  const rel = new RegExp(`${B}(?:in|om)\\s+(\\d+|an?|one|two|three|en|et|to|tre)?\\s*(half(?:\\s+an?)?|halv)?\\s*(minutes?|mins?|hours?|minutter|minut|timer|time)${A}`, 'iu').exec(rest);
  if (rel) {
    const n = rel[1] ? (/^\d+$/.test(rel[1]) ? Number(rel[1]) : NUMBERS[rel[1].toLowerCase()] ?? 1) : 1;
    const amount = rel[2] ? 0.5 : n;
    const unit = /^(hour|time|timer)/i.test(rel[3]) ? 3600000 : 60000;
    cut(rel);
    return { due: new Date(now.getTime() + amount * unit), rest: tidy(rest) };
  }

  let day: Date | null = null;
  let defaultHour = 9;
  const dayWord = new RegExp(`${B}(tomorrow|i\\s*morgen|today|i\\s*dag|tonight|this\\s+evening|i\\s*aften)${A}`, 'iu').exec(rest);
  if (dayWord) {
    const w = dayWord[1].toLowerCase().replace(/\s+/g, '');
    day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (/tomorrow|imorgen/.test(w) ? 1 : 0));
    if (/tonight|thisevening|iaften/.test(w)) defaultHour = 20;
    cut(dayWord);
  } else {
    const wd = new RegExp(`${B}(?:on\\s+|på\\s+|next\\s+|næste\\s+)?(${Object.keys(WEEKDAYS).join('|')})${A}`, 'iu').exec(rest);
    if (wd) {
      const target = WEEKDAYS[wd[1].toLowerCase()];
      const ahead = (target - now.getDay() + 7) % 7 || 7; // "Friday" said on a Friday means next week
      day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead);
      cut(wd);
    }
  }

  // "at 3 pm", "at 15:30", "kl. 15", "klokken 9.30", "3pm", "15:00"
  const clock = new RegExp(`${B}(?:(at|kl\\.?|klokken)\\s*)?(\\d{1,2})(?:[:.](\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?)?${A}`, 'giu');
  let hour = -1, minute = 0;
  for (let m = clock.exec(rest); m; m = clock.exec(rest)) {
    if (!m[1] && !m[3] && !m[4]) continue; // a bare number is not a time
    let h = Number(m[2]);
    const mm = m[3] ? Number(m[3]) : 0;
    if (h > 23 || mm > 59) continue;
    const meridiem = m[4] ? m[4].toLowerCase().replace(/\./g, '') : '';
    if (meridiem === 'pm' && h < 12) h += 12;
    else if (meridiem === 'am' && h === 12) h = 0;
    // English "at 3" means the afternoon; Danish "kl. 3" stays as said.
    else if (!meridiem && m[1] && m[1].toLowerCase() === 'at' && h >= 1 && h <= 7) h += 12;
    hour = h; minute = mm;
    cut(m);
    break;
  }

  if (hour < 0 && !day) return { rest: tidy(rest) };
  const base = day || new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const due = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour < 0 ? defaultHour : hour, minute);
  // A time already gone today means tomorrow.
  if (!day && due.getTime() <= now.getTime()) due.setDate(due.getDate() + 1);
  return { due, rest: tidy(rest) };
}

export function classify(text: string, now: Date): Command {
  const flat = text.replace(/\s+/g, ' ').trim();
  let m = TASK.exec(flat);
  if (m && flat.length > m[0].length) return { kind: 'task', body: tidy(flat.slice(m[0].length)) };
  m = IDEA.exec(flat);
  if (m && flat.length > m[0].length) return { kind: 'idea', body: tidy(flat.slice(m[0].length)) };
  m = REMIND.exec(flat);
  if (m && flat.length > m[0].length) {
    const when = parseWhen(flat.slice(m[0].length), now);
    return when.due ? { kind: 'reminder', body: when.rest, due: when.due } : { kind: 'reminder', body: when.rest };
  }
  return { kind: 'note', body: flat };
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "9:00", "15:30": no leading zero, like the chat list times.
export function clockLabel(date: Date): string {
  return String(date.getHours()) + ':' + String(date.getMinutes()).padStart(2, '0');
}

// Short confirmation for the phone chip: "Task saved", "Reminder 15:00", "Reminder Fri 9:00".
export function confirmLabel(command: Command, now: Date): string {
  if (command.kind === 'task') return 'Task saved';
  if (command.kind === 'idea') return 'Idea saved';
  if (command.kind === 'note') return 'Note saved';
  if (command.kind === 'meeting') return 'Meeting saved';
  if (!command.due) return 'Reminder, no time';
  const due = command.due;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.floor((due.getTime() - start) / 86400000);
  const day = days === 0 ? '' : days === 1 ? 'tomorrow ' : days < 7 ? DAYS[due.getDay()] + ' ' : due.getDate() + ' ' + MONTHS[due.getMonth()] + ' ';
  return 'Reminder ' + day + clockLabel(due);
}
