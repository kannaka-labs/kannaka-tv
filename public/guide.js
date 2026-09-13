'use strict';
// The programme guide. Reads the same schedule the rig does.
(function () {
  var el = function (id) { return document.getElementById(id); };
  var skew = 0;

  function text(tag, cls, value) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (value !== undefined && value !== null) n.textContent = String(value);
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function hhmm(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function dur(s) { return Math.floor(s / 60) + ':' + pad(s % 60); }

  function load() {
    var t0 = Date.now();
    fetch('/api/guide?hours=6', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        skew = j.serverNow - (t0 + (Date.now() - t0) / 2);
        renderGuide(j);
        renderDayparts(j.dayparts || []);
      })
      .catch(function () {
        var g = el('guide');
        clear(g);
        var n = text('div', 'notice', 'The schedule cannot be reached. The transmitter may be restarting.');
        n.setAttribute('data-kind', 'bad');
        g.appendChild(n);
      });
  }

  function renderGuide(j) {
    var root = el('guide');
    clear(root);
    var now = Date.now() + skew;
    var segs = j.segments || [];
    if (!segs.length) {
      root.appendChild(text('div', 'notice', 'Nothing is scheduled yet. The transmitter builds the schedule on start.'));
      return;
    }

    el('tally').setAttribute('data-state', 'on');
    el('tallyWord').textContent = 'ON AIR';

    var lastDaypart = null;
    var list = null;
    segs.forEach(function (s) {
      if (s.daypart !== lastDaypart) {
        lastDaypart = s.daypart;
        var dp = (j.dayparts || []).find(function (d) { return d.key === s.daypart; });
        root.appendChild(text('p', 'daypart-head', dp ? dp.label : s.daypart));
        list = text('ul', 'grid-guide');
        root.appendChild(list);
      }
      var onAir = now >= s.startsAt && now < s.endsAt;
      var li = document.createElement('li');
      li.setAttribute('data-onair', String(onAir));
      li.setAttribute('data-carriage', String(Boolean(s.carriage)));
      li.appendChild(text('span', 'g-time', hhmm(s.startsAt)));

      var mid = text('span', 'g-title', s.title);
      if (s.subtitle) mid.appendChild(text('span', 'g-sub', s.subtitle));
      if (s.carriage) mid.appendChild(text('span', 'g-sub', 'Carried for ' + s.carriage.label));
      li.appendChild(mid);

      li.appendChild(text('span', 'g-dur', onAir ? 'on air' : dur(s.duration)));
      list.appendChild(li);
    });
  }

  function renderDayparts(dps) {
    var root = el('dayparts');
    clear(root);
    dps.forEach(function (d) {
      var li = document.createElement('li');
      li.appendChild(text('span', 'g-time', pad(d.start) + ':00'));
      var mid = text('span', 'g-title', d.label);
      mid.appendChild(text('span', 'g-sub', DESCRIBE[d.key] || ''));
      li.appendChild(mid);
      li.appendChild(text('span', 'g-dur', (d.end - d.start) + 'h'));
      root.appendChild(li);
    });
  }

  var DESCRIBE = {
    'long-wave': 'Overnight. The radio under slow visuals, dreams, and the quiet formats.',
    'morning-report': 'What happened while you slept: dreams consolidated, markets moved, the city woke.',
    'the-board': 'Prediction markets, KAX commerce, and the exchange.',
    'city-desk': 'OpenBotCity, KAX City, citizens, stores and the tower.',
    prime: 'The long-form: features, new records, and the things worth sitting through.',
    'late-signal': 'Research and the strange end of the constellation.',
  };

  function tick() {
    el('timecode').textContent = new Date(Date.now() + skew).toTimeString().slice(0, 8);
    setTimeout(tick, 1000);
  }

  load();
  setInterval(load, 60000);
  tick();
})();
