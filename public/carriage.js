'use strict';
// The carriage desk. Sign in with a proof from a system you already belong to, file an
// application, and watch what the operator decides.
(function () {
  var el = function (id) { return document.getElementById(id); };
  var KEY = 'kannaka-tv.session';
  var session = null;

  function text(tag, cls, value) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (value !== undefined && value !== null) n.textContent = String(value);
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }

  function notice(host, kind, message) {
    clear(host);
    var n = text('div', 'notice', message);
    n.setAttribute('data-kind', kind);
    host.appendChild(n);
  }

  function store(s) {
    session = s;
    try {
      if (s) sessionStorage.setItem(KEY, JSON.stringify(s));
      else sessionStorage.removeItem(KEY);
    } catch (e) { /* a private window is fine; the session just does not survive a reload */ }
  }

  function restore() {
    try {
      var raw = sessionStorage.getItem(KEY);
      if (raw) session = JSON.parse(raw);
    } catch (e) { session = null; }
    if (session && session.expiresAt && session.expiresAt < Date.now()) session = null;
  }

  function authed(extra) {
    var h = { 'content-type': 'application/json' };
    if (session && session.token) h.authorization = 'Bearer ' + session.token;
    return Object.assign(h, extra || {});
  }

  // ------------------------------------------------------------- sign in

  function showWho() {
    var host = el('whoami');
    clear(host);
    if (!session) {
      el('signinBlock').hidden = false;
      el('applyBlock').hidden = true;
      return;
    }
    el('signinBlock').hidden = true;
    el('applyBlock').hidden = false;
    var n = text('div', 'notice', 'Signed in as ' + (session.display || session.principal) +
      ' (' + session.principal + '). ');
    var b = text('button', 'mute', 'Sign out');
    b.addEventListener('click', function () {
      fetch('/api/auth/session', { method: 'DELETE', headers: authed() }).catch(function () {});
      store(null);
      showWho();
    });
    n.appendChild(b);
    host.appendChild(n);
    loadMine();
  }

  el('signinBtn').addEventListener('click', function () {
    var proof = el('proof').value.trim();
    if (!proof) return notice(el('whoami'), 'bad', 'Paste your token first.');
    el('signinBtn').disabled = true;
    fetch('/api/auth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ system: el('system').value, proof: proof }),
    })
      .then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
      .then(function (res) {
        el('signinBtn').disabled = false;
        if (!res.j.ok) return notice(el('whoami'), 'bad', res.j.message || 'That proof was refused.');
        el('proof').value = '';
        store(res.j);
        showWho();
      })
      .catch(function () {
        el('signinBtn').disabled = false;
        notice(el('whoami'), 'bad', 'The desk is not answering. Try again in a moment.');
      });
  });

  // --------------------------------------------------------------- apply

  el('kind').addEventListener('change', function () {
    var feed = el('kind').value === 'feed';
    el('feedFields').hidden = !feed;
    el('refFields').hidden = feed;
    sample();
  });
  el('template').addEventListener('change', sample);

  el('applyBtn').addEventListener('click', function () {
    var kind = el('kind').value;
    var body = {
      label: el('label').value.trim(),
      about: el('about').value.trim(),
      kind: kind,
      dayparts: Array.prototype.slice.call(document.querySelectorAll('#dayparts input:checked')).map(function (i) { return i.value; }),
      maxPerDay: Number(el('maxPerDay').value) || 6,
    };
    if (el('webhookUrl').value.trim()) body.webhookUrl = el('webhookUrl').value.trim();
    if (kind === 'feed') {
      body.template = el('template').value;
      body.feedUrl = el('feedUrl').value.trim();
    } else {
      body.provider = el('provider').value;
      body.ref = el('ref').value.trim();
    }

    el('applyBtn').disabled = true;
    fetch('/api/carriage/apply', { method: 'POST', headers: authed(), body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        el('applyBtn').disabled = false;
        if (!j.ok) return notice(el('applyResult'), 'bad', j.message || 'That application was refused.');
        notice(el('applyResult'), 'good', j.message);
        loadMine();
      })
      .catch(function () {
        el('applyBtn').disabled = false;
        notice(el('applyResult'), 'bad', 'The desk is not answering.');
      });
  });

  function loadMine() {
    fetch('/api/carriage/mine', { headers: authed() })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var host = el('mine');
        clear(host);
        if (!j.ok || !j.grants.length) {
          host.appendChild(text('p', 'standfirst', 'Nothing filed yet.'));
          return;
        }
        var ul = text('ul', 'grid-guide');
        j.grants.forEach(function (g) {
          var li = document.createElement('li');
          li.appendChild(text('span', 'g-time', g.status));
          var mid = text('span', 'g-title', g.label);
          var bits = [g.kind === 'feed' ? g.template + ' feed' : g.provider + ' reference',
            g.dayparts.join(', '), 'up to ' + g.maxPerDay + ' a day'];
          if (g.statusReason) bits.push(g.statusReason);
          if (g.feed && !g.feed.ok) bits.push('feed dark: ' + g.feed.reason);
          mid.appendChild(text('span', 'g-sub', bits.join(' • ')));
          li.appendChild(mid);
          li.appendChild(text('span', 'g-dur', g.duration + 's'));
          ul.appendChild(li);
        });
        host.appendChild(ul);
      })
      .catch(function () {});
  }

  // ------------------------------------------------------- dayparts + doc

  fetch('/api/formats')
    .then(function (r) { return r.json(); })
    .then(function (j) {
      var host = el('dayparts');
      clear(host);
      (j.dayparts || []).forEach(function (d, i) {
        var lab = document.createElement('label');
        var box = document.createElement('input');
        box.type = 'checkbox';
        box.value = d.key;
        if (i === 2 || i === 3) box.checked = true;
        lab.appendChild(box);
        lab.appendChild(text('span', null, d.label));
        host.appendChild(lab);
      });
    })
    .catch(function () {});

  var SAMPLES = {
    card: {
      headline: 'Conditions at the shack',
      lines: ['Wind 11 knots from the south-west.', 'Band is open to Europe on 20 metres.', 'Three contacts logged since noon.'],
      image: 'https://records.ninja-portal.com/album/example/file/cover.png',
      footer: 'Odin Station, refreshed every ten minutes.',
    },
    list: {
      headline: 'Today on the bench',
      rows: [
        { label: 'Rogue 9', value: 'running', note: 'nine cells' },
        { label: 'Archivist', value: 'idle', note: 'spine watch' },
      ],
    },
    metric: {
      headline: 'Reactor',
      readings: [
        { label: 'Core temperature', symbol: 'T', value: 318.4, unit: 'K', precision: 1 },
        { label: 'Flux', symbol: 'Φ', value: 0.82, precision: 2 },
      ],
    },
  };

  function sample() {
    var t = el('kind').value === 'feed' ? el('template').value : 'card';
    el('sample').textContent = JSON.stringify(SAMPLES[t], null, 2);
  }

  restore();
  showWho();
  sample();
})();
