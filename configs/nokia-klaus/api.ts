// Bridge HTTP client (privileged mozSystem XHR) and connection probe.
namespace Klaus {
  export type RuntimeConfig = { bridgeUrl: string; bridgeToken: string; pollTimeoutMs?: number };

  export type ConnState = "NOT CONNECTED" | "CONNECTED" | "AUTH ERROR" | "GATEWAY DOWN" | "UNREACHABLE";

  export type XhrOptions = {
    body?: string | Blob | null;
    contentType?: string;
    requestId?: string;
    onSuccess: (status: number, text: string) => void;
    onError: (err: string) => void;
  };

  // Gecko 48 constructor form new XMLHttpRequest({mozSystem:true}). If the systemXHR
  // permission is not granted (old install) mozSystem stays false: surface an honest
  // error and never fall back to query-param tokens.
  export function xhr(cfg: RuntimeConfig, method: string, url: string, opts: XhrOptions): XMLHttpRequest | null {
    var XHRCtor = XMLHttpRequest as any;
    var req: XMLHttpRequest & { mozSystem?: boolean };
    try {
      req = new XHRCtor({ mozSystem: true });
    } catch (_e) {
      req = new XMLHttpRequest() as XMLHttpRequest & { mozSystem?: boolean };
    }
    if (!req.mozSystem) {
      opts.onError("systemXHR permission not active. Reinstall app with updated manifest.");
      return null;
    }
    req.open(method, url, true);
    req.setRequestHeader("Authorization", "Bearer " + cfg.bridgeToken);
    if (opts.contentType) req.setRequestHeader("Content-Type", opts.contentType);
    if (opts.requestId) req.setRequestHeader("X-Request-Id", opts.requestId);
    req.onload = function (): void { opts.onSuccess(req.status, req.responseText); };
    req.onerror = function (): void { opts.onError("Network error"); };
    req.ontimeout = function (): void { opts.onError("Request timed out"); };
    req.timeout = 30000;
    req.send(opts.body || null);
    return req;
  }

  // CONNECTED requires an authenticated GET /sessions (also triggers gateway cold start)
  // and a healthy /health (HTTP 200 + connected===true). 401/403 on /sessions is AUTH ERROR.
  export function probeConnection(cfg: RuntimeConfig, done: (state: ConnState) => void): void {
    if (!cfg.bridgeUrl || !cfg.bridgeToken) { done("NOT CONNECTED"); return; }
    xhr(cfg, "GET", cfg.bridgeUrl + "/sessions", {
      onSuccess: function (sessStatus: number): void {
        if (sessStatus === 401 || sessStatus === 403) { done("AUTH ERROR"); return; }
        xhr(cfg, "GET", cfg.bridgeUrl + "/health", {
          onSuccess: function (healthStatus: number, text: string): void {
            if (healthStatus !== 200) { done("GATEWAY DOWN"); return; }
            try { done(JSON.parse(text).connected === true ? "CONNECTED" : "GATEWAY DOWN"); }
            catch (_e) { done("GATEWAY DOWN"); }
          },
          onError: function (): void { done("UNREACHABLE"); }
        });
      },
      onError: function (): void { done("UNREACHABLE"); }
    });
  }
}
