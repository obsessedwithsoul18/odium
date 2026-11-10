/*
 * Discord OAuth launcher.
 * Builds the authorize URL with a fresh CSRF state value instead of a bare
 * meta-refresh, so the flow can be validated by the callback host.
 * Loaded as an external file because the site CSP forbids inline script.
 */
(function () {
  "use strict";

  var CLIENT_ID = "1436665568118706247";
  var REDIRECT  = "https://goodnight.llc/callback";
  var STATE_KEY = "odium_oauth_state";

  function randomState() {
    var bytes = new Uint8Array(32);
    var c = window.crypto || window.msCrypto;
    c.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) {
      return b.toString(16).padStart(2, "0");
    }).join("");
  }

  var state;
  try {
    state = sessionStorage.getItem(STATE_KEY);
    if (!state || !/^[0-9a-f]{64}$/.test(state)) {
      state = randomState();
      sessionStorage.setItem(STATE_KEY, state);
    }
  } catch (e) {
    state = randomState(); // private mode: still send state, just cannot persist
  }

  var url = "https://discord.com/oauth2/authorize" +
    "?client_id=" + encodeURIComponent(CLIENT_ID) +
    "&redirect_uri=" + encodeURIComponent(REDIRECT) +
    "&response_type=code" +
    "&scope=" + encodeURIComponent("identify") +
    "&state=" + encodeURIComponent(state) +
    "&prompt=" + encodeURIComponent("consent");

  var link = document.getElementById("go");
  if (link) link.href = url;
  window.location.replace(url);
})();
