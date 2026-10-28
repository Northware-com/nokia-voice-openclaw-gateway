// Safe offline template; the build always includes a config.js.
// For a connected package set NOKIA_BRIDGE_URL and NOKIA_CONFIG_FILE.
// The latter names a private mode-0600 JSON file containing token or bridgeToken.
// The build reads that file directly; never supply a token in command arguments.
// Live config is written only into a private ZIP outside the checkout.
var NOKIA_RUNTIME_CONFIG = {
  bridgeUrl: "",
  bridgeToken: ""
};
