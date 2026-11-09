(function () {
  "use strict";

  var nav = document.getElementById("homeNav");
  if (!nav) return;

  var onScroll = function () {
    nav.classList.toggle("scrolled", window.scrollY > 20);
  };

  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
})();
