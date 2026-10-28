interface AppRequest { error?: { name: string }; onsuccess: (() => void) | null; onerror: (() => void) | null; }
interface WebApp { manifestURL: string; launch(): AppRequest; }
interface MozActivityRequest { onsuccess: (() => void) | null; onerror: (() => void) | null; error?: { name: string }; }
interface MozActivityConstructor { new(options: { name: string; data: { type: string; number: string } }): MozActivityRequest; }
interface MozApps { mgmt: { getAll(): any }; }
interface LauncherWindow extends Window { navigator: Navigator & { mozApps?: MozApps }; MozActivity?: MozActivityConstructor; }

(function (): void {
  var urls: string[] = [
    "app://huginn-klaus-audio-proof/manifest.webapp",
    "app://communications.gaiamobile.org/manifest.webapp",
    "app://sms.gaiamobile.org/manifest.webapp"
  ];
  var names: string[] = ["Klaus", "Phone", "SMS"];
  var buttons = document.querySelectorAll("button[data-index]");
  var status = document.getElementById("status") as HTMLElement;
  var apps: { [url: string]: WebApp } = {};
  var selected = 0;
  var ready = false;
  var loading = true;

  function announce(message: string): void { status.textContent = message; }
  function select(index: number): void {
    selected = (index + buttons.length) % buttons.length;
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute("aria-pressed", i === selected ? "true" : "false");
    }
  }
  function launch(): void {
    if (selected === 1) {
      var Activity = (window as LauncherWindow).MozActivity;
      if (!Activity) { announce("Phone dialer activity unavailable."); return; }
      try {
        var dialRequest = new Activity({name: "dial", data: {type: "webtelephony/number", number: ""}});
        dialRequest.onsuccess = function (): void { announce("Opening phone keypad…"); };
        dialRequest.onerror = function (): void { announce("Could not open phone keypad: " + (dialRequest.error ? dialRequest.error.name : "unknown error")); };
      } catch (_error) { announce("Could not open phone keypad."); }
      return;
    }
    if (loading) { announce("Still loading apps…"); return; }
    if (!ready) { announce("App list unavailable. Reopen launcher to retry."); return; }
    var app = apps[urls[selected]];
    if (!app) { announce(names[selected] + " is not installed."); return; }
    try {
      var name = names[selected]; var request = app.launch();
      request.onsuccess = function (): void { announce("Opening " + name + "…"); };
      request.onerror = function (): void { announce("Could not open " + name + ": " + (request.error ? request.error.name : "unknown error")); };
    } catch (_error) { announce("Could not open " + names[selected] + "."); }
  }
  function loadApps(): void {
    var mozApps = (window as LauncherWindow).navigator.mozApps;
    if (!mozApps || !mozApps.mgmt) { loading = false; announce("App management API unavailable."); return; }
    try {
      var request = mozApps.mgmt.getAll();
      request.onsuccess = function (): void {
        var installed = request.result || [];
        for (var i = 0; i < installed.length; i++) {
          if (installed[i] && installed[i].manifestURL) apps[installed[i].manifestURL] = installed[i];
        }
        loading = false; ready = true;
        announce("Ready. Choose an app and press Enter.");
      };
      request.onerror = function (): void { loading = false; announce("Could not read installed apps."); };
    } catch (error) { loading = false; announce("Could not read installed apps."); }
  }
  document.addEventListener("keydown", function (event: KeyboardEvent): void {
    if (event.repeat) return;
    if (event.key === "ArrowUp" || event.keyCode === 38) { select(selected - 1); event.preventDefault(); }
    else if (event.key === "ArrowDown" || event.keyCode === 40) { select(selected + 1); event.preventDefault(); }
    else if (event.key === "Enter" || event.keyCode === 13) { launch(); event.preventDefault(); }
    else if (event.key === "1" || event.keyCode === 49) { select(0); launch(); event.preventDefault(); }
    else if (event.key === "2" || event.keyCode === 50) { select(1); launch(); event.preventDefault(); }
    else if (event.key === "3" || event.keyCode === 51) { select(2); launch(); event.preventDefault(); }
  });
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener("click", function (event: Event): void {
      var button = event.currentTarget as HTMLButtonElement;
      select(parseInt(button.getAttribute("data-index") || "0", 10)); launch();
    });
  }
  select(0);
  loadApps();
}());
