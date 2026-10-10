/* Contents rail: marks the section that is currently at the top of the
   viewport. Progressive enhancement; the page reads the same without it. */

(function () {
  var nav = document.querySelector('nav.contents');
  if (!nav) return;
  var links = Array.prototype.slice.call(nav.querySelectorAll('a[href^="#"]'));
  var entries = [];
  links.forEach(function (a) {
    var target = document.getElementById(a.getAttribute('href').slice(1));
    if (target) entries.push({ item: a.parentNode, target: target });
  });
  if (!entries.length) return;

  var current = null, queued = false;

  function update() {
    queued = false;
    var line = window.innerHeight * 0.3, pick = entries[0];
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].target.getBoundingClientRect().top <= line) pick = entries[i];
      else break;
    }
    if (pick === current) return;
    current = pick;
    entries.forEach(function (e) { e.item.classList.toggle('current', e === pick); });
  }

  function schedule() {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(update);
  }

  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  update();
})();
