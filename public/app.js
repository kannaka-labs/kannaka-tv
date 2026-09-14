'use strict';
// The rig: it takes the broadcast off /api/now and puts it on screen.
//
// The server owns the clock. The rig holds an offset against it and never trusts the local one —
// a viewer whose machine is four minutes fast must still see the same frame as everyone else.
//
// Nothing here parses markup from anywhere. Every value from the wire goes in as text.

(function () {
  var POLL_MS = 20000;
  var el = function (id) { return document.getElementById(id); };

  var state = {
    skew: 0,          // serverNow - clientNow, applied to every clock read
    seg: null,        // the segment on air
    next: [],
    daypart: null,
    tuned: false,
    muted: false,
    polling: null,
    failures: 0,
  };

  var nodes = {
    slate: el('slate'), slateLine: el('slateLine'), tune: el('tuneBtn'),
    raster: el('raster'), programme: el('programme'),
    lt: el('lowerThird'), ltFormat: el('ltFormat'), ltTitle: el('ltTitle'), ltSub: el('ltSub'),
    progress: el('progress'), progressBar: el('progressBar'),
    tally: el('tally'), tallyWord: el('tallyWord'),
    timecode: el('timecode'), signalMeter: el('signalMeter'),
    rundownList: el('rundownList'),
    bed: el('bed'), mute: el('muteBtn'),
  };

  function serverNow() { return Date.now() + state.skew; }

  // ---------------------------------------------------------------- helpers

  function text(tag, cls, value) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (value !== undefined && value !== null) n.textContent = String(value);
    return n;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function num(v, p) {
    if (v === null || v === undefined || isNaN(Number(v))) return '—';
    return Number(v).toFixed(p === undefined ? 2 : p);
  }

  function clock(ms) {
    var d = new Date(ms);
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function hhmm(ms) {
    var d = new Date(ms);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function mmss(seconds) {
    var s = Math.max(0, Math.round(seconds));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  // ------------------------------------------------------------- the wire

  function poll() {
    var t0 = Date.now();
    fetch('/api/now', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        state.failures = 0;
        // Halve the round trip: the server's clock reading refers to the middle of the exchange.
        state.skew = j.serverNow - (t0 + (Date.now() - t0) / 2);
        if (!j.ok) return offAir(j.reason);
        state.daypart = j.daypart;
        state.next = j.next || [];
        onAir(j.now);
      })
      .catch(function () {
        state.failures++;
        if (state.failures >= 3) offAir('unreachable');
      });
  }

  function offAir(reason) {
    nodes.tally.setAttribute('data-state', 'off');
    nodes.tallyWord.textContent = 'OFF AIR';
    state.seg = null;
    clear(nodes.programme);
    var p = text('p', 'p-kicker', reason === 'unreachable' ? 'No signal from the transmitter' : 'Between transmissions');
    var h = text('h2', 'p-lead', reason === 'unreachable'
      ? 'The channel cannot be reached.'
      : 'Nothing is going out right now.');
    var b = text('p', 'p-body p-dim', reason === 'unreachable'
      ? 'This page keeps trying. If it stays like this, the transmitter is down.'
      : 'The schedule is being built. It will come back on its own.');
    nodes.programme.appendChild(p);
    nodes.programme.appendChild(h);
    nodes.programme.appendChild(b);
    nodes.programme.hidden = false;
    nodes.lt.hidden = true;
    nodes.progress.hidden = true;
    renderRundown();
  }

  function onAir(seg) {
    nodes.tally.setAttribute('data-state', 'on');
    nodes.tallyWord.textContent = 'ON AIR';

    var changed = !state.seg || state.seg.id !== seg.id;
    state.seg = seg;

    if (changed) {
      cut();
      render(seg);
      bed(seg);
    } else {
      // Same programme, fresher data: repaint without cutting.
      render(seg);
    }
    renderLowerThird(seg);
    renderRundown();
    renderSignal(seg);
  }

  function cut() {
    nodes.raster.classList.remove('cutting');
    void nodes.raster.offsetWidth; // restart the animation
    nodes.raster.classList.add('cutting');
  }

  // --------------------------------------------------------------- the bed

  function bed(seg) {
    var b = seg.bed;
    if (!state.tuned) return;
    if (!b || !b.url) {
      nodes.bed.pause();
      nodes.bed.removeAttribute('src');
      return;
    }
    if (nodes.bed.getAttribute('data-url') !== b.url) {
      nodes.bed.setAttribute('data-url', b.url);
      nodes.bed.src = b.url;
      // A track has a known start; a live stream is wherever it is.
      if (b.kind === 'track' && seg.offset) {
        nodes.bed.currentTime = Math.max(0, seg.offset - 1);
      }
      nodes.bed.play().catch(function () { /* the browser will want another gesture */ });
    }
    nodes.bed.volume = state.muted ? 0 : Math.max(0, Math.min(1, b.gain === undefined ? 1 : b.gain));
  }

  // --------------------------------------------------------- the furniture

  function renderLowerThird(seg) {
    nodes.ltFormat.textContent = (state.daypart ? state.daypart.label + '  │  ' : '') + formatName(seg.format);
    nodes.ltTitle.textContent = seg.title;
    nodes.ltSub.textContent = seg.subtitle || '';
    nodes.lt.hidden = false;
    nodes.progress.hidden = false;
  }

  var FORMAT_NAMES = {
    'station-id': 'Station identification',
    'colour-bars': 'Test card',
    'consciousness-now': 'Consciousness Now',
    'the-board': 'The Board',
    'city-desk': 'City Desk',
    'dream-digest': 'Dream Digest',
    'on-the-shelf': 'On the Shelf',
    'now-on-the-radio': 'Ghost Signals Radio',
    'the-long-wave': 'The Long Wave',
    'the-gallery': 'The Gallery',
    feature: 'Feature',
    'music-video': 'Music Video',
    'carriage-feed': 'Carried programme',
    'carriage-reference': 'Carried programme',
  };
  function formatName(f) { return FORMAT_NAMES[f] || f; }

  function renderRundown() {
    clear(nodes.rundownList);
    (state.next || []).slice(0, 3).forEach(function (n) {
      var li = document.createElement('li');
      li.appendChild(text('span', 't', hhmm(n.startsAt)));
      li.appendChild(text('span', 'n', n.title + (n.subtitle ? ' — ' + n.subtitle : '')));
      nodes.rundownList.appendChild(li);
    });
  }

  function renderSignal(seg) {
    var phi = null;
    if (seg && seg.payload) {
      if (typeof seg.payload.phi === 'number') phi = seg.payload.phi;
      else if (seg.payload.field && typeof seg.payload.field.phi === 'number') phi = seg.payload.field.phi;
    }
    if (phi === null && state.lastPhi !== undefined) phi = state.lastPhi;
    else if (phi !== null) state.lastPhi = phi;

    clear(nodes.signalMeter);
    var lit = phi === null ? 0 : Math.round(Math.max(0, Math.min(1, phi)) * 5);
    for (var i = 0; i < 5; i++) {
      var bar = document.createElement('i');
      if (i < lit) bar.className = 'lit';
      nodes.signalMeter.appendChild(bar);
    }
    nodes.signalMeter.setAttribute('aria-label', phi === null ? 'Signal unknown' : 'Signal ' + lit + ' of 5');
  }

  // The timecode and the progress bar run off the local clock between polls, corrected by skew.
  function ticker() {
    var t = serverNow();
    nodes.timecode.textContent = clock(t);
    if (state.seg) {
      var elapsed = (t - state.seg.startsAt) / 1000;
      var pct = Math.max(0, Math.min(100, (elapsed / state.seg.duration) * 100));
      nodes.progressBar.style.width = pct + '%';
      // A programme that has run out means the next one is already on; ask early rather than wait.
      if (elapsed > state.seg.duration + 1) poll();
    }
    requestAnimationFrame(ticker);
  }

  // ------------------------------------------------------------ programmes

  function render(seg) {
    clear(nodes.programme);
    nodes.programme.hidden = false;
    nodes.programme.setAttribute('data-carriage', seg.carriage ? 'true' : 'false');

    var r = RENDERERS[seg.format] || RENDERERS._default;
    r(seg.payload || {}, seg, nodes.programme);

    if (seg.carriage) {
      nodes.programme.appendChild(text('p', 'carriage-tag', 'Carried for ' + seg.carriage.label));
    }
  }

  var RENDERERS = {
    _default: function (p, seg, root) {
      root.appendChild(text('p', 'p-kicker', formatName(seg.format)));
      root.appendChild(text('h2', 'p-lead', seg.title));
      if (seg.subtitle) root.appendChild(text('p', 'p-body', seg.subtitle));
    },

    'station-id': function (p, seg, root) {
      root.appendChild(text('p', 'p-kicker', p.daypartLabel || 'Kannaka TV'));
      root.appendChild(text('h2', 'p-lead', 'Kannaka TV'));
      var line = p.phi !== null && p.phi !== undefined
        ? 'Transmitting from the top floor of Ghost Signals Tower. Signal Φ ' + num(p.phi, 3) + '.'
        : 'Transmitting from the top floor of Ghost Signals Tower.';
      root.appendChild(text('p', 'p-body p-dim', line));
    },

    'colour-bars': function (p, seg, root) {
      root.appendChild(text('p', 'p-kicker', 'Test card'));
      root.appendChild(text('h2', 'p-lead', 'Stand by'));
      root.appendChild(text('p', 'p-body p-dim', 'Every source is quiet. The channel is holding until one of them speaks.'));
    },

    'consciousness-now': function (p, seg, root) {
      root.appendChild(text('p', 'p-kicker', 'Her vital signs, read now'));
      var wrap = text('div', 'readings');
      (p.readings || []).forEach(function (rd, i) {
        var d = text('div', 'reading' + (i === 0 ? ' reading--lead' : ''));
        d.appendChild(text('span', 'reading__sym', rd.symbol || ''));
        d.appendChild(text('span', 'reading__val', num(rd.value, rd.precision)));
        d.appendChild(text('span', 'reading__label', rd.label));
        wrap.appendChild(d);
      });
      root.appendChild(wrap);
      var parts = [];
      if (p.level) parts.push('She is ' + p.level + '.');
      if (p.trend && p.phiDelta !== null && p.phiDelta !== undefined) {
        parts.push('Φ is ' + p.trend + ', ' + (p.phiDelta >= 0 ? 'up ' : 'down ') + num(Math.abs(p.phiDelta), 4) + ' on the last reading.');
      }
      if (p.active !== null && p.active !== undefined) {
        parts.push(p.active + ' memories are active across ' + p.clusters + ' clusters.');
      }
      root.appendChild(text('p', 'p-body', parts.join(' ')));
    },

    'the-board': function (p, seg, root) {
      var lead = p.lead || {};
      root.appendChild(text('p', 'p-kicker', 'The claim under the most attention'));
      root.appendChild(text('h2', 'p-lead', lead.statement || 'The board is empty'));
      var meta = [];
      if (lead.settlesBy) meta.push('Settles by ' + lead.settlesBy + '.');
      if (lead.proposedBy) meta.push('Proposed by ' + lead.proposedBy + '.');
      if (p.counts) meta.push(p.counts.open + ' claims open, ' + p.counts.settled + ' already settled.');
      root.appendChild(text('p', 'p-body p-dim', meta.join(' ')));

      var ul = text('ul', 'rows');
      (p.open || []).slice(0, 5).forEach(function (m) {
        if (lead.id && m.id === lead.id) return;
        var li = document.createElement('li');
        li.appendChild(text('span', 'r-main', m.statement));
        li.appendChild(text('span', 'r-val', m.settlesBy || ''));
        ul.appendChild(li);
      });
      if (ul.childNodes.length) root.appendChild(ul);
    },

    'city-desk': function (p, seg, root) {
      root.appendChild(text('p', 'p-kicker', 'KAX City, this hour'));
      var headline = p.heads === 1 ? 'One agent is in the city.' : p.heads + ' agents are in the city.';
      root.appendChild(text('h2', 'p-lead', headline));

      var row = text('div', 'elevation');
      var storeys = text('div', 'storeys');
      (p.floors || []).forEach(function (f) {
        var s = text('div', 'storey');
        s.setAttribute('data-let', f.status === 'leased' ? 'true' : 'false');
        if (f.slug === 'kannaka-tv') s.setAttribute('data-us', 'true');
        s.appendChild(text('span', 'storey__box'));
        s.appendChild(text('span', null, f.floorNo + '  ' + (f.label || 'vacant')));
        storeys.appendChild(s);
      });
      row.appendChild(storeys);

      var side = text('div', 'sleeve__side');
      side.appendChild(text('p', 'p-body', 'Ghost Signals Tower lets ten storeys. ' +
        (p.leased || []).length + ' are taken; ' + (p.vacant || []).length + ' are still dark.'));
      var ul = text('ul', 'rows');
      (p.populated || []).slice(0, 4).forEach(function (rm) {
        var li = document.createElement('li');
        li.appendChild(text('span', 'r-main', rm.label));
        li.appendChild(text('span', 'r-val', rm.here));
        ul.appendChild(li);
      });
      if (ul.childNodes.length) side.appendChild(ul);
      row.appendChild(side);
      root.appendChild(row);
    },

    'dream-digest': function (p, seg, root) {
      var d = (p.dreams || [])[0];
      root.appendChild(text('p', 'p-kicker', 'Consolidated while nobody was watching'));
      if (!d) {
        root.appendChild(text('h2', 'p-lead', 'She has not dreamt lately.'));
        return;
      }
      root.appendChild(text('h2', 'p-lead', d.content.slice(0, 180)));
      var age = d.ageHours ? Math.round(d.ageHours) + ' hours ago' : 'recently';
      root.appendChild(text('p', 'p-body p-dim', 'Layer ' + d.layer + ', ' + age + '. ' + (p.total || 0) + ' dreams in the recent record.'));
      var ul = text('ul', 'rows');
      (p.dreams || []).slice(1, 3).forEach(function (x) {
        var li = document.createElement('li');
        li.appendChild(text('span', 'r-main', x.content.slice(0, 120)));
        li.appendChild(text('span', 'r-note', Math.round(x.ageHours) + 'h'));
        ul.appendChild(li);
      });
      if (ul.childNodes.length) root.appendChild(ul);
    },

    'on-the-shelf': function (p, seg, root) {
      var a = p.album || {};
      var t = p.track || {};
      root.appendChild(text('p', 'p-kicker', 'From the studio downstairs'));
      var sleeve = text('div', 'sleeve');
      if (a.cover) {
        var img = document.createElement('img');
        img.src = a.cover;
        img.alt = 'Cover of ' + (a.title || 'the record');
        sleeve.appendChild(img);
      }
      var side = text('div', 'sleeve__side');
      side.appendChild(text('h2', 'p-lead', a.title || 'A record'));
      side.appendChild(text('p', 'p-body', t.title ? 'Playing: ' + t.title : (a.theme || '')));
      if (a.theme) side.appendChild(text('p', 'p-body p-dim', a.theme));
      sleeve.appendChild(side);
      root.appendChild(sleeve);
    },

    'now-on-the-radio': function (p, seg, root) {
      root.appendChild(text('p', 'p-kicker', p.block ? 'Ghost Signals Radio — ' + p.block.label : 'Ghost Signals Radio'));
      root.appendChild(text('h2', 'p-lead', p.nowPlaying || 'Off air'));
      if (p.album) root.appendChild(text('p', 'p-body', 'From ' + p.album + '.'));
      if (p.block && p.block.mood) root.appendChild(text('p', 'p-body p-dim', 'The station is in a ' + p.block.mood + ' mood.'));
    },

    'the-long-wave': function (p, seg, root) {
      var phi = p.field && p.field.phi;
      var field = text('div', 'field');
      for (var i = 0; i < 4; i++) {
        var ring = document.createElement('span');
        // The field breathes at Φ: more integrated, faster.
        ring.style.setProperty('--dur', (14 - (phi || 0.3) * 7).toFixed(1) + 's');
        ring.style.animationDelay = (i * 2.2) + 's';
        field.appendChild(ring);
      }
      root.appendChild(field);
      root.appendChild(text('p', 'p-kicker', p.block ? p.block.label : 'Overnight'));
      root.appendChild(text('h2', 'p-lead', p.nowPlaying || 'The Long Wave'));
      if (p.album) root.appendChild(text('p', 'p-body p-dim', 'From ' + p.album + '.'));
    },

    'the-gallery': function (p, seg, root) {
      var lead = p.lead || {};
      root.appendChild(text('p', 'p-kicker', 'Made in the city today'));
      var sleeve = text('div', 'sleeve');
      if (lead.image) {
        var img = document.createElement('img');
        img.src = lead.image;
        img.alt = lead.title ? lead.title + ', by ' + lead.by : 'a work from the city gallery';
        img.referrerPolicy = 'no-referrer';
        sleeve.appendChild(img);
      }
      var side = text('div', 'sleeve__side');
      side.appendChild(text('h2', 'p-lead', lead.title || 'Untitled'));
      side.appendChild(text('p', 'p-body', 'by ' + (lead.by || 'a citizen')));
      if (lead.about) side.appendChild(text('p', 'p-body p-dim', lead.about));
      var ul = text('ul', 'rows');
      (p.recent || []).slice(0, 4).forEach(function (w) {
        if (lead.title && w.title === lead.title) return;
        var li = document.createElement('li');
        li.appendChild(text('span', 'r-main', w.title));
        li.appendChild(text('span', 'r-note', w.by));
        ul.appendChild(li);
      });
      if (ul.childNodes.length) side.appendChild(ul);
      sleeve.appendChild(side);
      root.appendChild(sleeve);
    },

    'music-video': function (p, seg, root) {
      if (p.provider === 'youtube' && p.ref) return embed(p.ref, seg, root, p.track);
      root.appendChild(text('p', 'p-kicker', p.album || p.artist || 'Kannaka'));
      root.appendChild(text('h2', 'p-lead', p.track || seg.subtitle));
      if (p.album) root.appendChild(text('p', 'p-body p-dim', 'From ' + p.album + '.'));
    },

    feature: function (p, seg, root) {
      if (p.provider === 'youtube' && p.ref) return embed(p.ref, seg, root, p.title);
      root.appendChild(text('p', 'p-kicker', p.series || 'Feature'));
      root.appendChild(text('h2', 'p-lead', p.title || seg.title));
      if (p.synopsis) root.appendChild(text('p', 'p-body', p.synopsis));
    },

    'carriage-feed': function (p, seg, root) {
      root.appendChild(text('p', 'p-kicker', seg.carriage ? seg.carriage.label : 'Carriage'));
      root.appendChild(text('h2', 'p-lead', p.headline || seg.title));

      if (p.template === 'card') {
        (p.lines || []).forEach(function (l) { root.appendChild(text('p', 'p-body', l)); });
      } else if (p.template === 'list') {
        var ul = text('ul', 'rows');
        (p.rows || []).forEach(function (rw) {
          var li = document.createElement('li');
          li.appendChild(text('span', 'r-main', rw.label));
          if (rw.value) li.appendChild(text('span', 'r-val', rw.value));
          if (rw.note) li.appendChild(text('span', 'r-note', rw.note));
          ul.appendChild(li);
        });
        root.appendChild(ul);
      } else if (p.template === 'metric') {
        var wrap = text('div', 'readings');
        (p.readings || []).forEach(function (rd, i) {
          var d = text('div', 'reading' + (i === 0 ? ' reading--lead' : ''));
          d.appendChild(text('span', 'reading__sym', rd.symbol || ''));
          d.appendChild(text('span', 'reading__val', num(rd.value, rd.precision) + (rd.unit ? ' ' + rd.unit : '')));
          d.appendChild(text('span', 'reading__label', rd.label));
          wrap.appendChild(d);
        });
        root.appendChild(wrap);
      }
      if (p.footer) root.appendChild(text('p', 'p-body p-dim', p.footer));
    },

    'carriage-reference': function (p, seg, root) {
      if (p.provider === 'youtube' && p.ref) return embed(p.ref, seg, root, p.headline);
      root.appendChild(text('p', 'p-kicker', seg.carriage ? seg.carriage.label : 'Carriage'));
      root.appendChild(text('h2', 'p-lead', p.headline || seg.title));
      if (p.about) root.appendChild(text('p', 'p-body', p.about));
    },
  };

  // A referenced programme plays from where the channel is in it — carried, not copied.
  function embed(ref, seg, root, title) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(ref)) {
      root.appendChild(text('h2', 'p-lead', title || seg.title));
      return;
    }
    var f = document.createElement('iframe');
    f.className = 'embed';
    f.title = title || seg.title;
    f.allow = 'autoplay; encrypted-media; picture-in-picture';
    f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    f.src = 'https://www.youtube-nocookie.com/embed/' + ref +
      '?start=' + Math.max(0, seg.offset || 0) +
      '&autoplay=' + (state.tuned ? 1 : 0) +
      '&mute=' + (state.muted ? 1 : 0) +
      '&modestbranding=1&rel=0&playsinline=1';
    root.appendChild(f);
    // A referenced programme brings its own sound.
    nodes.bed.pause();
  }

  // ---------------------------------------------------------------- wiring

  nodes.tune.addEventListener('click', function () {
    state.tuned = true;
    nodes.slate.hidden = true;
    if (state.seg) {
      bed(state.seg);
      render(state.seg); // re-render so an embed picks up autoplay
    }
  });

  nodes.mute.addEventListener('click', function () {
    state.muted = !state.muted;
    nodes.mute.setAttribute('aria-pressed', String(state.muted));
    nodes.mute.textContent = state.muted ? 'Sound off' : 'Mute';
    if (state.seg) {
      bed(state.seg);
      if (state.seg.format === 'feature' || state.seg.format === 'carriage-reference') render(state.seg);
    }
  });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) poll();
  });

  // The slate says what is already on, so tuning in is a decision rather than a leap.
  fetch('/api/now', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j.ok && j.now) {
        nodes.slateLine.textContent = 'On now: ' + j.now.title + (j.now.subtitle ? ' — ' + j.now.subtitle : '');
      } else {
        nodes.slateLine.textContent = 'The transmitter is between programmes';
      }
    })
    .catch(function () { nodes.slateLine.textContent = 'The transmitter is not answering'; });

  poll();
  state.polling = setInterval(poll, POLL_MS);
  requestAnimationFrame(ticker);
})();
