/*
 * Odium — page behaviour.
 * Nav scroll state, FAQ tabs, FAQ accordion, pointer tilt on preview cards.
 * No dependencies, no build step. Replaces the previous obfuscated bundle.
 */
(function () {
  "use strict";

  /* ---------- sticky nav state ---------- */

  function initNavScroll() {
    var nav = document.getElementById("homeNav");
    if (!nav) return;

    var ticking = false;
    function apply() {
      nav.classList.toggle("scrolled", window.scrollY > 20);
      ticking = false;
    }
    window.addEventListener("scroll", function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(apply);
    }, { passive: true });
    apply();
  }

  /* ---------- FAQ tabs ---------- */

  function initFaqTabs() {
    var tabs = Array.prototype.slice.call(document.querySelectorAll(".home-faq-tab"));
    var panels = Array.prototype.slice.call(document.querySelectorAll(".home-faq-panel"));
    if (!tabs.length || !panels.length) return;

    var group = tabs[0].parentElement;

    function moveIndicator(tab) {
      if (!group || !tab) return;
      var left = tab.offsetLeft;
      group.style.setProperty("--indicator-left", left + "px");
      group.style.setProperty("--indicator-width", tab.offsetWidth + "px");
    }

    function activate(name) {
      var current = null;
      tabs.forEach(function (tab) {
        var on = tab.getAttribute("data-tab") === name;
        tab.classList.toggle("active", on);
        tab.setAttribute("aria-selected", on ? "true" : "false");
        if (on) current = tab;
      });
      panels.forEach(function (panel) {
        var on = panel.getAttribute("data-panel") === name;
        panel.classList.toggle("active", on);
      });
      moveIndicator(current);
    }

    tabs.forEach(function (tab) {
      tab.setAttribute("role", "tab");
      tab.addEventListener("click", function () {
        var name = tab.getAttribute("data-tab");
        if (name) activate(name);
      });
    });

    var initial = tabs.find(function (t) { return t.classList.contains("active"); }) || tabs[0];
    if (initial && initial.getAttribute("data-tab")) {
      activate(initial.getAttribute("data-tab"));
    }

    window.addEventListener("resize", function () {
      var active = tabs.find(function (t) { return t.classList.contains("active"); });
      moveIndicator(active);
    }, { passive: true });
  }

  /* ---------- FAQ accordion ---------- */

  function initAccordion() {
    var questions = document.querySelectorAll(".home-faq-question");

    Array.prototype.forEach.call(questions, function (button) {
      var item = button.closest(".home-faq-item");
      if (!item) return;

      button.setAttribute("aria-expanded", item.classList.contains("open") ? "true" : "false");
      button.addEventListener("click", function () {
        var open = item.classList.toggle("open");
        button.setAttribute("aria-expanded", open ? "true" : "false");
      });
    });
  }

  /* ---------- feature wheel ---------- */

  function initFeatureWheel() {
    var track = document.querySelector(".domains-scroll-vertical");
    if (!track) return;

    var pills = Array.prototype.slice.call(track.querySelectorAll(".domain-pill-vertical"));
    if (!pills.length) return;

    var SLOT = 70;      // px between two pills
    var SPEED = 24;     // px per second, upward
    var FALLOFF = 3.4;  // slots from centre before a pill is fully faded
    var total = pills.length * SLOT;
    var offset = 0;
    var last = 0;
    var running = true;

    pills.forEach(function (pill) {
      pill.style.position = "absolute";
      pill.style.left = "50%";
      pill.style.willChange = "transform, opacity";
    });

    function draw(now) {
      if (!last) last = now;
      var dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      if (running) offset = (offset + SPEED * dt) % total;

      for (var i = 0; i < pills.length; i++) {
        var rel = (i * SLOT - offset) % total;
        if (rel < -total / 2) rel += total;
        if (rel > total / 2) rel -= total;

        var slots = Math.abs(rel) / SLOT;
        var scale = 1 - (Math.min(slots, FALLOFF) / FALLOFF) * 0.5;
        var opacity = Math.max(0, 1 - slots * 0.31);

        var pill = pills[i];
        pill.style.top = "calc(50% + " + rel.toFixed(1) + "px)";
        pill.style.transform = "translate(-50%, -50%) scale(" + scale.toFixed(3) + ")";
        pill.style.opacity = opacity.toFixed(3);
      }
      window.requestAnimationFrame(draw);
    }

    var card = track.closest(".bento-card");
    if (card) {
      card.addEventListener("pointerenter", function () { running = false; });
      card.addEventListener("pointerleave", function () { running = true; });
    }

    window.requestAnimationFrame(draw);
  }

  /* ---------- preview card tilt ---------- */

  function initTilt() {
    var cards = document.querySelectorAll("[data-tilt]");
    var MAX_Y = 30;
    var MAX_X = 8;

    Array.prototype.forEach.call(cards, function (card) {
      var rest = card.style.transform || "";

      function onMove(event) {
        var rect = card.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        var px = (event.clientX - rect.left) / rect.width;
        var py = (event.clientY - rect.top) / rect.height;
        var rotateY = MAX_Y / 2 - px * MAX_Y;
        var rotateX = py * MAX_X;
        card.style.transform =
          "perspective(1000px) rotateY(" + rotateY.toFixed(2) + "deg) rotateX(" + rotateX.toFixed(2) + "deg)";
      }

      function onLeave() {
        card.style.transform = rest;
      }

      card.addEventListener("pointermove", onMove);
      card.addEventListener("pointerleave", onLeave);
      card.addEventListener("pointercancel", onLeave);
    });
  }

  /* ---------- boot ---------- */

  function boot() {
    initNavScroll();
    initFaqTabs();
    initAccordion();
    initFeatureWheel();
    initTilt();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
