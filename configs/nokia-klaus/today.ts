// Today screen (chat list, 4): reminders due today and the latest notes, tasks, ideas and
// meetings from the notes service (GET /today). Pure helpers; app.ts fetches and caches.
namespace Klaus {
  export type TodayData = {
    date: string;
    reminders: Array<{ due: string | null; text: string; overdue: boolean }>;
    undated: number;
    latest: Array<{ kind: string; summary: string; created: string }>;
  };

  export type TodayRow = { cls: string; tag: string; time: string; text: string };
  export type TodaySection = { title: string; rows: TodayRow[] };

  var KIND_TAG: { [kind: string]: string } = { task: "Task", idea: "Idea", meeting: "Meet", note: "Note" };

  // Only well-formed fields survive; texts are clipped so a bad reply cannot flood the screen.
  export function validateToday(raw: any): TodayData | null {
    if (!raw || typeof raw.date !== "string" || !Array.isArray(raw.reminders) || !Array.isArray(raw.latest)) return null;
    var str = function (v: any): string { return typeof v === "string" ? v.slice(0, 200) : ""; };
    return {
      date: raw.date.slice(0, 10),
      reminders: raw.reminders.slice(0, 20).filter(function (r: any): boolean { return r && typeof r.text === "string"; })
        .map(function (r: any): { due: string | null; text: string; overdue: boolean } {
          return { due: typeof r.due === "string" ? r.due : null, text: str(r.text), overdue: r.overdue === true };
        }),
      undated: typeof raw.undated === "number" && raw.undated > 0 ? Math.floor(raw.undated) : 0,
      latest: raw.latest.slice(0, 10).filter(function (r: any): boolean { return r && typeof r.summary === "string"; })
        .map(function (r: any): { kind: string; summary: string; created: string } {
          return { kind: KIND_TAG[r.kind] ? r.kind : "note", summary: str(r.summary), created: str(r.created) };
        })
    };
  }

  function clock(ts: number): string {
    var d = new Date(ts);
    return d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes();
  }

  var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  export function todayTitle(now: number): string {
    var d = new Date(now);
    return "Today · " + WEEKDAYS[d.getDay()] + " " + d.getDate() + " " + MONTH_NAMES[d.getMonth()];
  }

  // Freshness line: "Updated just now", "Offline · 14:05 · OK retries" (one line, also in large text).
  export function todayFreshness(fetchedAt: number, now: number, failed: boolean, loading: boolean): string {
    if (!fetchedAt) return loading ? "Loading from Plato…" : "Plato unreachable · OK retries";
    var when = relTime(fetchedAt, now);
    var age = when === "now" ? "just now" : /m$/.test(when) ? when + " ago" : when;
    if (loading) return "Updating…";
    return failed ? "Offline · " + age + " · OK retries" : "Updated " + age;
  }

  export function todaySections(d: TodayData, now: number): TodaySection[] {
    var reminders: TodayRow[] = [];
    for (var i = 0; i < d.reminders.length; i++) {
      var r = d.reminders[i];
      var ts = r.due ? new Date(r.due).getTime() : NaN;
      var time = isNaN(ts) ? "" : r.overdue ? relTime(ts, now) : clock(ts);
      var cls = r.overdue ? "late" : !isNaN(ts) && ts < now ? "past" : "";
      reminders.push({ cls: cls, tag: "", time: time, text: r.text || "Reminder" });
    }
    if (!reminders.length) reminders.push({ cls: "none", tag: "", time: "", text: "No reminders today" });
    if (d.undated) reminders.push({ cls: "none", tag: "", time: "", text: "+" + d.undated + " without a time" });

    var latest: TodayRow[] = [];
    for (var j = 0; j < d.latest.length; j++) {
      var it = d.latest[j];
      var created = it.created ? new Date(it.created).getTime() : NaN;
      latest.push({ cls: "k-" + it.kind, tag: KIND_TAG[it.kind] || "Note", time: isNaN(created) ? "" : relTime(created, now), text: it.summary });
    }
    if (!latest.length) latest.push({ cls: "none", tag: "", time: "", text: "Nothing in Plato's inbox yet" });

    return [
      { title: "Reminders", rows: reminders },
      { title: "Latest in Plato's inbox", rows: latest },
      { title: "Calendar & mail", rows: [{ cls: "none", tag: "", time: "", text: "Not connected yet" }] }
    ];
  }
}
