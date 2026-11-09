/*
 * Retrac checkout controller.
 * Reads window.RETRAC_CONFIG, renders every payment rail, handles copy + order reference.
 * No inline handlers, no framework, no build step.
 */
(function () {
  "use strict";

  var CFG = window.RETRAC_CONFIG;
  if (!CFG) {
    console.error("config.js missing");
    return;
  }

  var $ = function (sel, root) { return (root || document).querySelector(sel); };

  /* ---------- order reference ---------- */

  var REF_KEY = "retrac_order_ref";

  function makeRef() {
    var alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1
    var body = "";
    var bytes = new Uint8Array(6);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(bytes);
    } else {
      for (var b = 0; b < 6; b++) bytes[b] = Math.floor(Math.random() * 256);
    }
    for (var i = 0; i < 6; i++) body += alphabet[bytes[i] % alphabet.length];
    return CFG.product.orderPrefix + "-" + body;
  }

  function getRef() {
    var ref = null;
    try { ref = sessionStorage.getItem(REF_KEY); } catch (e) { /* private mode */ }
    if (!ref) {
      ref = makeRef();
      try { sessionStorage.setItem(REF_KEY, ref); } catch (e) { /* ignore */ }
    }
    return ref;
  }

  var ORDER_REF = getRef();

  /* ---------- money formatting ---------- */

  function amount() {
    return CFG.product.price.toFixed(2);
  }

  /* ---------- copy helper ---------- */

  function copyText(value, btn) {
    var done = function () {
      var original = btn.getAttribute("data-label") || btn.textContent;
      btn.setAttribute("data-label", original);
      btn.textContent = "Copied";
      btn.classList.add("is-done");
      window.setTimeout(function () {
        btn.textContent = original;
        btn.classList.remove("is-done");
      }, 1400);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(done, function () { legacyCopy(value, done); });
    } else {
      legacyCopy(value, done);
    }
  }

  function legacyCopy(value, done) {
    var ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }

  /* ---------- field builders ---------- */

  function field(label, value, copyable) {
    var row = document.createElement("div");
    row.className = "retrac-field";

    var left = document.createElement("div");
    var lab = document.createElement("span");
    lab.className = "retrac-field-label";
    lab.textContent = label;
    var val = document.createElement("span");
    val.className = "retrac-field-value";
    val.textContent = value;
    left.appendChild(lab);
    left.appendChild(val);
    row.appendChild(left);

    if (copyable) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "retrac-copy";
      btn.textContent = "Copy";
      btn.addEventListener("click", function () { copyText(value, btn); });
      row.appendChild(btn);
    }
    return row;
  }

  function cta(label, href, external) {
    var a = document.createElement("a");
    a.className = "retrac-cta";
    a.textContent = label;
    a.href = href || "#";
    if (external) {
      a.target = "_blank";
      a.rel = "noopener";
    }
    return a;
  }

  function lede(text) {
    var p = document.createElement("p");
    p.className = "retrac-pane-lede";
    p.textContent = text;
    return p;
  }

  /* ---------- paypal sdk ---------- */

  var paypalSdk = null;

  function apiBase(cfg) {
    return String((cfg && cfg.apiBase) || "").replace(/\/+$/, "");
  }

  function loadPayPalSdk(clientId, currency) {
    if (paypalSdk) return paypalSdk;
    paypalSdk = new Promise(function (resolve, reject) {
      if (window.paypal && window.paypal.Buttons) { resolve(window.paypal); return; }
      var script = document.createElement("script");
      script.src = "https://www.paypal.com/sdk/js?client-id=" + encodeURIComponent(clientId) +
        "&currency=" + encodeURIComponent(currency || "USD") +
        "&intent=capture&components=buttons&disable-funding=credit";
      script.async = true;
      script.onload = function () {
        if (window.paypal && window.paypal.Buttons) resolve(window.paypal);
        else reject(new Error("PayPal SDK loaded without Buttons"));
      };
      script.onerror = function () { reject(new Error("PayPal SDK blocked or offline")); };
      document.head.appendChild(script);
    });
    return paypalSdk;
  }

  function postJson(url, payload) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
        return data;
      });
    });
  }

  function renderPaid(mount, status, data) {
    mount.innerHTML = "";
    var box = document.createElement("div");
    box.className = "retrac-paid";

    var title = document.createElement("div");
    title.className = "retrac-paid-title";
    title.textContent = "Paid " + CFG.currency.symbol + Number(data.amount).toFixed(2) + " — order confirmed";

    var body = document.createElement("p");
    body.className = "retrac-paid-body";
    body.textContent = "Order " + data.reference + " is locked in. License and download are released in Discord within " +
      CFG.product.deliveryWindow + ". Keep the reference for any follow-up.";

    var meta = document.createElement("div");
    meta.className = "retrac-paid-meta";
    meta.textContent = "PayPal capture " + data.captureId + (data.mode === "sandbox" ? " · sandbox" : "");

    box.appendChild(title);
    box.appendChild(body);
    box.appendChild(meta);
    mount.appendChild(box);

    status.className = "retrac-note is-quiet";
    status.textContent = data.emailed
      ? "Payment receipt emailed to the store."
      : "Payment confirmed. Save your order reference.";
  }

  function startPayPal(cfg, mount, status) {
    var base = apiBase(cfg);
    var say = function (text, tone) {
      status.className = "retrac-note" + (tone ? " is-" + tone : "");
      status.textContent = text;
    };

    fetch(base + "/api/paypal/config")
      .then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (data) {
            throw new Error(data.error || ("config " + res.status));
          });
        }
        return res.json();
      })
      .then(function (info) {
        var id = String(info.clientId || "");
        if (!/^A[A-Za-z0-9_-]{10,}$/.test(id)) {
          throw new Error("the store's PayPal client ID is not a client ID (" +
            (id ? id.length + " chars, starts \"" + id.slice(0, 4) + "\"" : "empty") +
            ") — fix PAYPAL_SANDBOX_CLIENT_ID on the API");
        }
        return loadPayPalSdk(id, info.currency).then(function (pp) {
          return { pp: pp, info: info };
        });
      })
      .then(function (bundle) {
        if (bundle.info.mode === "sandbox") {
          say("Sandbox mode — no real money moves. Sign in with a sandbox personal account to run the test.", "warn");
        }
        bundle.pp.Buttons({
          style: { layout: "vertical", shape: "pill", color: "gold", label: "paypal", height: 44 },
          createOrder: function () {
            return postJson(base + "/api/paypal/order", { reference: ORDER_REF }).then(function (d) {
              return d.id;
            });
          },
          onApprove: function (data) {
            say("Capturing payment…");
            return postJson(base + "/api/paypal/capture", { orderId: data.orderID, reference: ORDER_REF })
              .then(function (d) { renderPaid(mount, status, d); });
          },
          onCancel: function () {
            say("Payment cancelled. Nothing was charged.");
          },
          onError: function (err) {
            say("PayPal could not finish: " + (err && err.message ? err.message : "unknown") + ". Nothing was charged.", "error");
          }
        }).render(mount);
      })
      .catch(function (err) {
        var message = err && err.message ? err.message : "unknown";
        if (message.indexOf("config 404") !== -1) {
          message = "no API on this domain. If the site is on Cloudflare Pages, set payments.paypal.apiBase to the Worker URL in js/config.js.";
        }
        if (message.indexOf("SDK blocked") !== -1) {
          message = "the PayPal script would not load. An ad blocker, a VPN, or a Content-Security-Policy rule is blocking paypal.com.";
        }
        say("PayPal is offline right now. Use another rail, or send your order reference to support. (" + message + ")", "error");
      });
  }

  /* ---------- rail renderers ---------- */

  var RAILS = {
    crypto: function (cfg) {
      var out = [];
      if (cfg.mode === "invoice") {
        out.push(lede("Hosted crypto checkout. Pick any coin on the invoice page — the amount is locked to " + CFG.currency.symbol + amount() + " and the reference is attached automatically."));
        out.push(cta("Open crypto invoice", cfg.invoiceUrl, true));
        out.push(field("Order reference", ORDER_REF, true));
        return out;
      }

      out.push(lede("Send exactly " + CFG.currency.symbol + amount() + " of any listed asset. Include the order reference as the payment memo where the chain supports it."));
      Object.keys(cfg.addresses || {}).forEach(function (coin) {
        var addr = cfg.addresses[coin];
        if (!addr || addr.indexOf("REPLACE") === 0) return;
        out.push(field(coin, addr, true));
      });
      out.push(field("Order reference", ORDER_REF, true));
      return out;
    },

    paypal: function (cfg) {
      var out = [];
      if (cfg.mode === "sdk") {
        out.push(lede("PayPal balance, linked bank or card. Confirmation lands on this page the moment the payment clears."));
        var mount = document.createElement("div");
        mount.className = "retrac-paypal-mount";
        out.push(mount);
        var status = document.createElement("div");
        status.className = "retrac-note is-quiet";
        out.push(status);
        out.push(field("Order reference", ORDER_REF, true));
        startPayPal(cfg, mount, status);
        return out;
      }

      out.push(lede("PayPal Goods & Services. Buyer protection applies and confirmation is instant."));
      if (cfg.mode === "link" && cfg.link && cfg.link.indexOf("REPLACE") === -1) {
        out.push(cta("Pay " + CFG.currency.symbol + amount() + " with PayPal", cfg.link, true));
      }
      if (cfg.email && cfg.email.indexOf("REPLACE") === -1) {
        out.push(field("PayPal address", cfg.email, true));
      }
      out.push(field("Order reference", ORDER_REF, true));
      if (cfg.note) {
        var n = document.createElement("div");
        n.className = "retrac-note";
        n.textContent = cfg.note;
        out.push(n);
      }
      return out;
    },

    cashapp: function (cfg) {
      var out = [];
      out.push(lede("Cash App transfer. US accounts, no buyer fee, arrives instantly."));
      if (cfg.cashtag && cfg.cashtag.indexOf("REPLACE") === -1) {
        out.push(field("Cashtag", cfg.cashtag, true));
      }
      if (cfg.link && cfg.link.indexOf("REPLACE") === -1) {
        out.push(cta("Pay " + CFG.currency.symbol + amount() + " with Cash App", cfg.link, true));
      }
      out.push(field("Order reference", ORDER_REF, true));
      if (cfg.note) {
        var n = document.createElement("div");
        n.className = "retrac-note";
        n.textContent = cfg.note;
        out.push(n);
      }
      return out;
    },

    stripe: function (cfg) {
      var out = [];
      out.push(lede("Card checkout through Stripe. Visa, Mastercard, Amex, Apple Pay and Google Pay. Instant confirmation, receipt by email."));
      if (cfg.paymentLink && cfg.paymentLink.indexOf("REPLACE") === -1) {
        out.push(cta("Pay " + CFG.currency.symbol + amount() + " by card", cfg.paymentLink, true));
      } else {
        var warn = document.createElement("div");
        warn.className = "retrac-note";
        warn.innerHTML = "<strong>Stripe link not set.</strong> Paste your Payment Link into <code>js/config.js</code> under <code>payments.stripe.paymentLink</code>.";
        out.push(warn);
      }
      out.push(field("Order reference", ORDER_REF, true));
      return out;
    }
  };

  var ICONS = {
    crypto: '<svg fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 8h3.25a2.25 2.25 0 0 1 0 4.5H9.5m0 0h3.5a2.25 2.25 0 0 1 0 4.5H9.5M9.5 8v9M11 6v2m0 9v2"/></svg>',
    paypal: '<svg fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M7 20l2.5-14h6a4 4 0 0 1 0 8H10"/><path d="M10.5 14H15"/></svg>',
    cashapp: '<svg fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M15 6.5C14 5.6 12.9 5 11.6 5 9.6 5 8 6.3 8 8.1c0 4 8 2.3 8 6.6 0 2-1.8 3.3-4 3.3-1.5 0-2.7-.6-3.6-1.6"/><path d="M12 3v2m0 14v2"/></svg>',
    stripe: '<svg fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19"/><path d="M6.5 15h4"/></svg>'
  };

  /* ---------- render ---------- */

  function render() {
    var tabs = $("#payTabs");
    var panes = $("#payPanes");
    var keys = Object.keys(CFG.payments).filter(function (k) { return CFG.payments[k].enabled; });

    var wanted = new URLSearchParams(window.location.search).get("method");
    var active = keys.indexOf(wanted) !== -1 ? wanted : keys[0];

    keys.forEach(function (key) {
      var cfg = CFG.payments[key];

      var tab = document.createElement("button");
      tab.type = "button";
      tab.className = "retrac-tab" + (key === active ? " is-active" : "");
      tab.setAttribute("role", "tab");
      tab.setAttribute("data-rail", key);
      tab.setAttribute("aria-selected", key === active ? "true" : "false");
      tab.innerHTML = (ICONS[key] || "") + "<span></span>";
      tab.querySelector("span").textContent = cfg.label;
      tab.addEventListener("click", function () { select(key); });
      tabs.appendChild(tab);

      var pane = document.createElement("div");
      pane.className = "retrac-pane" + (key === active ? " is-active" : "");
      pane.setAttribute("data-pane", key);
      (RAILS[key] || function () { return [lede("Unavailable.")]; })(cfg).forEach(function (node) {
        pane.appendChild(node);
      });
      panes.appendChild(pane);
    });

    function select(key) {
      Array.prototype.forEach.call(tabs.children, function (t) {
        var on = t.getAttribute("data-rail") === key;
        t.classList.toggle("is-active", on);
        t.setAttribute("aria-selected", on ? "true" : "false");
      });
      Array.prototype.forEach.call(panes.children, function (p) {
        p.classList.toggle("is-active", p.getAttribute("data-pane") === key);
      });
      if (window.history && window.history.replaceState) {
        var url = new URL(window.location.href);
        url.searchParams.set("method", key);
        window.history.replaceState({}, "", url);
      }
    }
  }

  /* ---------- summary ---------- */

  function renderSummary() {
    $("#priceAmount").textContent = amount();

    var list = $("#includesList");
    (CFG.product.includes || []).forEach(function (item) {
      var li = document.createElement("li");
      li.innerHTML = '<svg fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg><span></span>';
      li.querySelector("span").textContent = item;
      list.appendChild(li);
    });

    var support = CFG.brand.discordInvite;
    $("#supportLink").href = support;
    $("#footerCopy").textContent = "Copyright \u00a9 " + new Date().getFullYear() + " " + CFG.brand.siteName + " - All Rights Reserved.";
  }

  function navScroll() {
    var nav = document.getElementById("homeNav");
    if (!nav) return;
    var onScroll = function () {
      nav.classList.toggle("scrolled", window.scrollY > 20);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  document.addEventListener("DOMContentLoaded", function () {
    renderSummary();
    render();
    navScroll();
  });
})();
