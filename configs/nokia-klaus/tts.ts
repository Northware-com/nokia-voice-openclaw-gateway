// Serialized text-to-speech queue. Items are bound to their session at enqueue time;
// switching sessions never drops other sessions' queued replies.
namespace Klaus {
  var queue: Array<{ text: string; sessionId: string }> = [];
  var speaking = false;
  var token = 0; // guards stale onend callbacks after cancel/replay

  function voices(): Array<{ lang: string }> {
    try { return speechSynthesis.getVoices ? speechSynthesis.getVoices() : []; } catch (_e) { return []; }
  }

  export function ttsNext(): void {
    if (speaking || !queue.length) return;
    var item = queue.shift()!;
    var myToken = ++token;
    try {
      var utter = new SpeechSynthesisUtterance(item.text);
      utter.lang = ttsLang(item.text, voices());
      utter.onend = function (): void { if (token === myToken) { speaking = false; ttsNext(); } };
      utter.onerror = function (): void { if (token === myToken) { speaking = false; ttsNext(); } };
      speaking = true;
      speechSynthesis.speak(utter);
    } catch (_e) { speaking = false; ttsNext(); }
  }

  export function ttsEnqueue(text: string, sessionId: string): void {
    for (var i = 0; i < queue.length; i++) {
      if (queue[i].sessionId === sessionId && queue[i].text === text) return;
    }
    queue.push({ text: text, sessionId: sessionId });
    ttsNext();
  }

  // Speak now: cancel current speech only and put this item at the head of the queue.
  export function ttsSpeakNow(text: string, sessionId: string): void {
    ttsInterrupt();
    for (var i = queue.length - 1; i >= 0; i--) {
      if (queue[i].sessionId === sessionId && queue[i].text === text) queue.splice(i, 1);
    }
    queue.unshift({ text: text, sessionId: sessionId });
    ttsNext();
  }

  // Stop the current utterance (e.g. while recording); queued items survive.
  export function ttsInterrupt(): void {
    try { speechSynthesis.cancel(); } catch (_e) { /* unsupported */ }
    token++;
    speaking = false;
  }
}
