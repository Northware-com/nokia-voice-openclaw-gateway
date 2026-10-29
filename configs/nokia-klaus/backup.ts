// Local backup: one JSON file with every phone-stored chat plus the display and
// sound settings. The export is a plain local snapshot: it never contains the
// bridge URL, tokens, client or server ids, request ids or anything the build
// received from the private config. Schema is versioned so a future restore can
// check what it reads.
namespace Klaus {
  export type BackupSettings = {
    autoread: boolean;
    haptics: boolean;
    night: boolean;
    large: boolean;
  };

  export type BackupFile = { version: number; app: string; at: number; chats: any[]; settings: BackupSettings; };

  export var BACKUP_VERSION = 1;

  export function buildBackup(sessions: LocalSession[], settings: BackupSettings): BackupFile {
    var chats: any[] = [];
    var messages = 0;
    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      var msgs: any[] = [];
      for (var j = 0; j < s.messages.length; j++) {
        var m = s.messages[j];
        msgs.push(m.voice === true ? { role: m.role, text: m.text, voice: true } : { role: m.role, text: m.text });
      }
      messages += msgs.length;
      chats.push({
        id: s.id,
        title: s.title,
        pinned: s.pinned === true,
        named: s.named === true,
        archived: s.archived === true,
        updatedAt: s.updatedAt || 0,
        messages: msgs
      });
    }
    return {
      version: BACKUP_VERSION,
      app: "klaus",
      at: Date.now(),
      chats: chats,
      settings: {
        autoread: settings.autoread === true,
        haptics: settings.haptics === true,
        night: settings.night === true,
        large: settings.large === true
      }
    };
  }

  // Count words for the one-line on-screen summary.
  export function backupSummary(file: BackupFile): string {
    var chats = file.chats.length;
    var msgs = 0;
    for (var i = 0; i < file.chats.length; i++) msgs += file.chats[i].messages.length;
    return chats + (chats === 1 ? " chat" : " chats") + ", " + msgs + (msgs === 1 ? " message" : " messages");
  }

  // KaiOS sets appDataPaths for privileged installs (the sandbox); the fs core
  // module is reachable through the app's require. Either missing means the
  // filesystem API is unavailable and the caller falls back to the console.
  export function understandFilesystem(): { fs: any; dir: string } | null {
    try {
      if (typeof (window as any).navigator === "undefined") return null;
      var paths = (navigator as any).appDataPaths;
      if (!paths || typeof paths.app !== "string") return null;
      var req = (window as any).require;
      if (typeof req !== "function") return null;
      var fs = req("fs");
      if (!fs || typeof fs.writeFileSync !== "function") return null;
      return { fs: fs, dir: paths.app };
    } catch (_e) { return null; }
  }

  // yyyy-MM-dd for the file name, from the app's clock (never the network).
  function backupFileName(at: number): string {
    var d = new Date(at);
    var p = (n: number): string => (n < 10 ? "0" : "") + n;
    return "klaus-backup-" + d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + ".json";
  }

  // One file per day; returns the written path, or null when the filesystem
  // API is missing or the write failed.
  export function writeBackup(file: BackupFile): string | null {
    var sys = understandFilesystem();
    if (!sys) return null;
    var path = sys.dir + "/" + backupFileName(file.at);
    try {
      sys.fs.writeFileSync(path, JSON.stringify(file, null, 2), { encoding: "utf8", mode: 0o600 });
      return path;
    } catch (_e) { return null; }
  }
}