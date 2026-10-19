'use strict';

var socket = null;
var socketOpen = false;
var state = null;
var errorText = '';
var notice = '';
var copied = false;
var coverName = '';
var joinCode = '';
var customPrompt = '';
var draft = '';
var ratingDraft = {};
var errorTimer = 0;
var copiedTimer = 0;
var jumpTop = false;

var saved = loadSession();
if (saved) {
  coverName = saved.name;
  joinCode = saved.code;
}

function loadSession() {
  try {
    var raw = sessionStorage.getItem('conspiraparty');
    if (!raw) return null;
    var data = JSON.parse(raw);
    if (!data || !data.code || !data.name) return null;
    return { code: String(data.code), name: String(data.name) };
  } catch (err) {
    return null;
  }
}

function saveSession(code, name) {
  try {
    sessionStorage.setItem('conspiraparty', JSON.stringify({ code: code, name: name }));
  } catch (err) { /* private mode */ }
}

function clearSession() {
  try { sessionStorage.removeItem('conspiraparty'); } catch (err) { /* ignore */ }
}

function wsUrl() {
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return proto + '//' + location.host + '/ws';
}

function showError(message) {
  errorText = message;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(function () {
    errorText = '';
    render();
  }, 5000);
  render();
}

function send(obj) {
  if (!socket || socket.readyState !== 1) {
    showError('Still reconnecting. Hold that thought.');
    return;
  }
  notice = '';
  socket.send(JSON.stringify(obj));
}

function cleanName(raw) {
  var name = String(raw || '').replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
  if (name.length < 1 || name.length > 16) return '';
  return name;
}

function createGame() {
  var name = cleanName(coverName);
  if (!name) {
    showError('Cover names are 1 to 16 characters. Make one up.');
    return;
  }
  coverName = name;
  send({ type: 'create', name: name });
}

function joinGame() {
  var name = cleanName(coverName);
  var code = String(joinCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  joinCode = code;
  if (!name) {
    showError('Cover names are 1 to 16 characters. Make one up.');
    return;
  }
  if (code.length !== 4) {
    showError('The code is 4 characters. No I, O, 0, or 1.');
    return;
  }
  coverName = name;
  send({ type: 'join', code: code, name: name });
}

function leaveGame() {
  send({ type: 'leave' });
  clearSession();
  state = null;
  draft = '';
  customPrompt = '';
  ratingDraft = {};
  render();
}

function copyCode(code) {
  var done = function () {
    copied = true;
    render();
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(function () {
      copied = false;
      render();
    }, 1500);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(code).then(done).catch(function () {
      showError('Copy failed. Read the code aloud. That is the old way.');
    });
    return;
  }
  showError('Copy failed. Read the code aloud. That is the old way.');
}

function connect() {
  socket = new WebSocket(wsUrl());
  socket.onopen = function () {
    socketOpen = true;
    var session = loadSession();
    if (session) send({ type: 'join', code: session.code, name: session.name });
    else render();
  };
  socket.onclose = function () {
    socketOpen = false;
    render();
    setTimeout(connect, 800);
  };
  socket.onerror = function () { /* close will follow */ };
  socket.onmessage = function (ev) {
    var msg;
    try { msg = JSON.parse(ev.data); } catch (err) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'pong' || msg.type === 'ping') return;
    if (msg.type === 'kicked') {
      clearSession();
      state = null;
      notice = msg.message || 'Your cover was claimed elsewhere.';
      render();
      return;
    }
    if (msg.type === 'error') {
      var message = msg.message || 'Something did not file.';
      if (/no file under that code/i.test(message)) {
        clearSession();
        state = null;
      } else if (!state && /another cover|briefing is full/i.test(message)) {
        clearSession();
      }
      showError(message);
      return;
    }
    if (msg.type === 'state') applyState(msg);
  };
}

function applyState(msg) {
  var prev = state;
  var phaseChanged = !prev || prev.phase !== msg.phase || prev.round !== msg.round || prev.code !== msg.code;
  state = msg;
  errorText = '';
  if (msg.you && msg.you.name) saveSession(msg.code, msg.you.name);
  if (phaseChanged && msg.phase === 'writing') {
    draft = msg.yourAnswer || '';
    customPrompt = '';
  }
  if (phaseChanged && msg.phase === 'rating') ratingDraft = {};
  if (msg.phase === 'rating' && msg.ballots) {
    for (var i = 0; i < msg.ballots.length; i += 1) {
      var ballot = msg.ballots[i];
      if (ratingDraft[ballot.token] == null && ballot.score) ratingDraft[ballot.token] = ballot.score;
    }
  }
  if (phaseChanged && msg.phase !== 'rating') ratingDraft = {};
  if (phaseChanged) jumpTop = true;
  render();
  if (prev && prev.phase !== msg.phase && navigator.vibrate) {
    try { navigator.vibrate(12); } catch (err) { /* ignore */ }
  }
}

function h(tag, attrs) {
  var node = document.createElement(tag);
  var children = [];
  for (var i = 2; i < arguments.length; i += 1) children.push(arguments[i]);
  if (attrs) {
    var keys = Object.keys(attrs);
    for (var k = 0; k < keys.length; k += 1) {
      var key = keys[k];
      var value = attrs[key];
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'onsubmit' || key === 'onclick' || key === 'oninput') {
        node.addEventListener(key.slice(2), value);
      } else if ((key === 'value') && (tag === 'INPUT' || tag === 'TEXTAREA')) node.value = value;
      else if (key === 'disabled' || key === 'checked') node[key] = !!value;
      else node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (var c = 0; c < children.length; c += 1) appendChild(node, children[c]);
  return node;
}

function appendChild(node, child) {
  if (child == null || child === false) return;
  if (Array.isArray(child)) {
    for (var i = 0; i < child.length; i += 1) appendChild(node, child[i]);
    return;
  }
  if (child.nodeType) node.appendChild(child);
  else node.appendChild(document.createTextNode(String(child)));
}

function mount(node) {
  var root = document.getElementById('app');
  root.dataset.phase = state ? state.phase : 'home';
  while (root.firstChild) root.removeChild(root.firstChild);
  root.appendChild(node);
}

function liveCount(players) {
  var n = 0;
  for (var i = 0; i < players.length; i += 1) if (players[i].connected) n += 1;
  return n;
}

function statusFor(player, phase) {
  if (!player.connected) return 'signal lost';
  if (phase === 'writing') return player.submitted ? 'theory filed' : 'still scribbling';
  if (phase === 'rating') return player.rated ? 'judged' : 'still judging';
  return 'live';
}

function banners() {
  var bits = [];
  if (!socketOpen) {
    bits.push(h('p', { class: 'toast bad', role: 'status' }, 'Signal degraded. Reconnecting…'));
  }
  if (notice) bits.push(h('p', { class: 'toast', role: 'status' }, notice));
  if (errorText) bits.push(h('p', { class: 'toast bad', role: 'alert' }, errorText));
  return bits;
}

function brand() {
  return h('header', {},
    h('p', { class: 'brandline' },
      h('span', { class: 'rec', 'aria-hidden': 'true' }),
      'CONSPIRAPARTY'
    ),
    h('p', { class: 'brandsub' }, 'Field terminal')
  );
}

function codeBar(current) {
  return h('div', { class: 'codebar' },
    h('div', {},
      h('div', { class: 'eyebrow' }, 'Case file'),
      h('div', { class: 'code', id: 'room-code' }, current.code)
    ),
    h('button', {
      type: 'button',
      class: 'ghost small',
      onclick: function () { copyCode(current.code); },
    }, copied ? 'Copied' : 'Copy code')
  );
}

function roster(current) {
  return h('ul', { class: 'roster' }, current.players.map(function (player) {
    return h('li', {},
      h('span', { class: player.connected ? 'dot' : 'dot off', 'aria-hidden': 'true' }),
      h('span', { class: 'who' },
        h('span', { class: 'name' }, player.name + (player.isYou ? ' (you)' : '')),
        h('span', { class: 'status' }, statusFor(player, current.phase))
      ),
      player.isHost ? h('span', { class: 'badge' }, 'Host') : null
    );
  }));
}

function claimBanner(current) {
  var host = null;
  for (var i = 0; i < current.players.length; i += 1) {
    if (current.players[i].isHost) host = current.players[i];
  }
  if (!host || host.connected || current.you.isHost) return null;
  return h('div', { class: 'claim' },
    h('p', {}, 'The host’s signal dropped. Someone has to keep the file moving.'),
    h('button', {
      type: 'button',
      class: 'primary',
      onclick: function () { send({ type: 'claim' }); },
    }, 'Claim the host file')
  );
}

function syncCustom(event) {
  customPrompt = event.target.value.slice(0, 180);
  if (event.target.value !== customPrompt) event.target.value = customPrompt;
  var count = document.getElementById('prompt-count');
  if (count) count.textContent = customPrompt.length + '/180';
  var button = document.getElementById('use-custom');
  if (button && state) button.disabled = !customPrompt.trim() || liveCount(state.players) < 2;
}

function syncDraft(event) {
  draft = event.target.value.slice(0, 400);
  if (event.target.value !== draft) event.target.value = draft;
  var count = document.getElementById('draft-count');
  if (count) count.textContent = draft.length + '/400';
  var button = document.getElementById('file-theory');
  if (button) button.disabled = !draft.trim();
}

function hostControls(current) {
  var enough = liveCount(current.players) >= 2;
  var next = current.phase === 'results';
  return h('section', { class: 'hostbox' },
    h('h2', {}, next ? 'Next conspiracy' : 'Open a conspiracy'),
    h('p', { class: 'hint' }, next
      ? 'Results stay on screen until you do. Let them argue.'
      : 'Read the code out loud. Codes never use I, O, 0, or 1.'),
    h('button', {
      type: 'button',
      class: 'primary',
      disabled: !enough,
      onclick: function () { send({ type: 'start', prompt: '' }); },
    }, next ? 'Draw the next prompt' : 'Draw a random prompt'),
    h('label', { for: 'custom-prompt' }, 'Or type a conspiracy'),
    h('textarea', {
      id: 'custom-prompt',
      maxlength: '180',
      placeholder: 'The vending machine is laundering quarters.',
      value: customPrompt,
      oninput: syncCustom,
    }),
    h('p', { class: 'counter', id: 'prompt-count' }, customPrompt.length + '/180'),
    h('button', {
      type: 'button',
      class: 'ghost',
      id: 'use-custom',
      disabled: !enough || !customPrompt.trim(),
      onclick: function () { send({ type: 'start', prompt: customPrompt.trim() }); },
    }, 'Use this conspiracy'),
    enough ? null : h('p', { class: 'hint' }, 'Need two live operatives before the seal breaks.')
  );
}

function promptCard(current, tab) {
  return h('article', { class: 'dossier' },
    h('div', { class: 'tab' }, tab || 'Classified'),
    h('div', { class: 'strip' },
      h('span', {}, 'Round ' + current.round),
      h('span', {}, current.code)
    ),
    h('p', { class: 'kicker' }, 'The conspiracy'),
    h('h2', { class: 'prompt' }, current.prompt || '—')
  );
}

function footer() {
  return h('footer', { class: 'footer' },
    state ? h('button', { type: 'button', class: 'texty', onclick: leaveGame }, 'Slip out of the file') : null,
    h('p', {},
      'A ridiculous party game for ',
      h('a', {
        href: 'https://www.conspiraparty.com',
        target: '_blank',
        rel: 'noopener noreferrer',
      }, 'conspiraparty.com')
    )
  );
}

function viewHome() {
  return h('div', { class: 'app' },
    banners(),
    brand(),
    h('h1', {}, 'They don’t want you comparing notes.'),
    h('p', { class: 'lede' }, 'One person opens a file. Everyone else slips in with the code. You each invent a theory, then rate the other lies.'),
    h('article', { class: 'dossier' },
      h('div', { class: 'tab' }, 'Top secret'),
      h('div', { class: 'strip' },
        h('span', {}, 'Party file'),
        h('span', {}, 'Not evidence')
      ),
      h('p', { class: 'kicker' }, 'How a round goes'),
      h('ol', { class: 'steps' },
        h('li', {}, 'Join on your phone. Same room, silly cover names.'),
        h('li', {}, 'A made-up conspiracy hits every screen. File your theory. No peeking.'),
        h('li', {}, 'Rate everyone else’s answer from 1 to 5. Highest average wins the argument.')
      ),
      h('div', { class: 'redactions', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'))
    ),
    h('form', {
      onsubmit: function (event) {
        event.preventDefault();
        var active = document.activeElement;
        if (active && active.id === 'join-code') joinGame();
        else if (String(joinCode || '').trim()) joinGame();
        else createGame();
      },
    },
      h('label', { for: 'cover-name' }, 'Cover name'),
      h('input', {
        id: 'cover-name',
        type: 'text',
        maxlength: '16',
        autocomplete: 'nickname',
        placeholder: 'Agent Pigeon',
        value: coverName,
        oninput: function (event) { coverName = event.target.value; },
      }),
      h('button', { type: 'button', class: 'primary', onclick: createGame }, 'Open a new file'),
      h('div', { class: 'or' }, 'or slip into one'),
      h('label', { for: 'join-code' }, 'Room code'),
      h('input', {
        id: 'join-code',
        type: 'text',
        maxlength: '4',
        autocapitalize: 'characters',
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder: 'K7QP',
        value: joinCode,
        oninput: function (event) {
          joinCode = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
          event.target.value = joinCode;
        },
      }),
      h('button', { type: 'button', class: 'ghost', onclick: joinGame }, 'Enter with the code')
    ),
    footer()
  );
}

function viewLobby(current) {
  var count = liveCount(current.players);
  return h('div', { class: 'app' },
    banners(),
    brand(),
    codeBar(current),
    h('h1', {}, 'Briefing room'),
    h('p', { class: 'lede' }, current.you.isHost
      ? 'You are the host. Start when at least two of you are live.'
      : 'You are in. The host breaks the seal when the table is ready.'),
    claimBanner(current),
    h('article', { class: 'dossier' },
      h('div', { class: 'tab' }, 'Roster'),
      h('div', { class: 'strip' },
        h('span', {}, count + ' live'),
        h('span', {}, current.players.length + ' on the file')
      ),
      roster(current)
    ),
    current.you.isHost
      ? hostControls(current)
      : h('p', { class: 'wait', style: 'margin-top:16px' }, 'Sit tight. When the host starts, the same conspiracy lands on every phone.'),
    footer()
  );
}

function viewWriting(current) {
  var filed = 0;
  for (var i = 0; i < current.players.length; i += 1) {
    if (current.players[i].submitted) filed += 1;
  }
  var composer;
  if (current.you.submitted) {
    composer = h('article', { class: 'dossier' },
      h('div', { class: 'tab' }, 'Filed'),
      h('div', { class: 'strip' },
        h('span', {}, 'Your theory'),
        h('span', {}, 'Sealed')
      ),
      h('p', { class: 'answer' }, current.yourAnswer || ''),
      h('p', { class: 'yours' }, 'The others cannot read this until every live operative files, or the host locks the pile.')
    );
  } else {
    composer = h('div', {},
      h('label', { for: 'theory' }, 'Your theory'),
      h('textarea', {
        id: 'theory',
        maxlength: '400',
        placeholder: 'Be specific. Be ridiculous. Be wrong with confidence.',
        value: draft,
        oninput: syncDraft,
      }),
      h('p', { class: 'counter', id: 'draft-count' }, draft.length + '/400'),
      h('button', {
        type: 'button',
        class: 'primary',
        id: 'file-theory',
        disabled: !draft.trim(),
        onclick: function () { send({ type: 'answer', text: draft.trim() }); },
      }, 'File this theory')
    );
  }
  return h('div', { class: 'app' },
    banners(),
    brand(),
    codeBar(current),
    h('h1', {}, 'File your theory'),
    h('p', { class: 'lede' }, 'Same prompt on every phone. You will not see the other answers yet.'),
    claimBanner(current),
    promptCard(current, 'Leak'),
    composer,
    h('p', { class: 'progress', 'aria-live': 'polite' }, filed + ' of ' + current.players.length + ' theories filed'),
    h('article', { class: 'dossier' },
      h('div', { class: 'tab' }, 'Who'),
      h('div', { class: 'strip' },
        h('span', {}, 'Operatives'),
        h('span', {}, 'No texts')
      ),
      roster(current)
    ),
    current.you.isHost ? h('button', {
      type: 'button',
      class: 'ghost',
      onclick: function () { send({ type: 'lock' }); },
    }, 'Lock theories and move on') : null,
    current.you.isHost ? h('p', { class: 'hint' }, 'Use this if someone wandered off. Unfiled operatives just won’t be on the board.') : null,
    footer()
  );
}

function viewRating(current) {
  var ballots = current.ballots || [];
  var ready = ballots.every(function (ballot) { return ratingDraft[ballot.token] >= 1; });
  var waiting = 0;
  for (var i = 0; i < current.players.length; i += 1) {
    if (current.players[i].connected && !current.players[i].rated) waiting += 1;
  }
  return h('div', { class: 'app' },
    banners(),
    brand(),
    codeBar(current),
    h('h1', {}, 'Rate the other theories'),
    h('p', { class: 'lede' }, '1 is nonsense. 5 is dangerously plausible. You do not rate your own.'),
    claimBanner(current),
    promptCard(current, 'Still classified'),
    ballots.length === 0
      ? h('p', { class: 'wait' }, 'Nothing for you to rate. That’s suspicious, but fine.')
      : ballots.map(function (ballot, index) {
        return h('article', { class: 'dossier ballot' },
          h('div', { class: 'tab' }, 'Theory ' + (index + 1)),
          h('div', { class: 'strip' },
            h('span', {}, 'Author redacted'),
            h('span', {}, 'Rate it')
          ),
          h('p', { class: 'answer' }, ballot.text),
          h('div', { class: 'rates', role: 'group', 'aria-label': 'Rating for theory ' + (index + 1) },
            [1, 2, 3, 4, 5].map(function (n) {
              var on = ratingDraft[ballot.token] === n;
              return h('button', {
                type: 'button',
                class: on ? 'rate on' : 'rate',
                'aria-pressed': on ? 'true' : 'false',
                'aria-label': String(n) + ' out of 5',
                disabled: !!current.you.rated,
                onclick: function () {
                  if (current.you.rated) return;
                  ratingDraft[ballot.token] = n;
                  render();
                },
              }, String(n));
            })
          )
        );
      }),
    current.yourAnswer ? h('p', { class: 'yours' }, 'Your theory is in the pile. People can read it, but not your name, until the reveal.') : h('p', { class: 'yours' }, 'You didn’t file one. You can still judge.'),
    current.you.rated
      ? h('p', { class: 'progress', 'aria-live': 'polite' }, 'Ratings filed. ' + waiting + ' still judging.')
      : h('button', {
        type: 'button',
        class: 'primary',
        disabled: ballots.length > 0 && !ready,
        onclick: function () {
          var scores = {};
          for (var b = 0; b < ballots.length; b += 1) scores[ballots[b].token] = ratingDraft[ballots[b].token];
          send({ type: 'rate', scores: scores });
        },
      }, ready || ballots.length === 0 ? 'File your ratings' : 'Rate every theory'),
    h('article', { class: 'dossier' },
      h('div', { class: 'tab' }, 'Jury'),
      h('div', { class: 'strip' },
        h('span', {}, 'Still out'),
        h('span', {}, waiting + ' judging')
      ),
      roster(current)
    ),
    current.you.isHost ? h('button', {
      type: 'button',
      class: 'ghost',
      onclick: function () { send({ type: 'lock' }); },
    }, 'Seal ratings and reveal') : null,
    current.you.isHost ? h('p', { class: 'hint' }, 'Skips anyone still staring at their phone. Votes already in still count.') : null,
    footer()
  );
}

function withRanks(results) {
  var last = null;
  var seen = false;
  var rank = 0;
  return results.map(function (row, index) {
    if (!seen || row.average !== last) {
      rank = index + 1;
      last = row.average;
      seen = true;
    }
    return {
      name: row.name,
      text: row.text,
      average: row.average,
      votes: row.votes,
      isYou: row.isYou,
      plausible: row.plausible,
      rank: rank,
    };
  });
}

function voteLabel(n) {
  if (!n) return 'No ratings';
  if (n === 1) return '1 rating';
  return n + ' ratings';
}

function viewResults(current) {
  var rows = withRanks(current.results || []);
  var cards = rows.map(function (row) {
    var ribbon = null;
    if (row.plausible) ribbon = h('p', { class: 'ribbon' }, 'Most plausible');
    else if (current.loneTheory && rows.length === 1) ribbon = h('p', { class: 'ribbon' }, 'Uncontested');
    return h('article', { class: row.plausible || (current.loneTheory && rows.length === 1) ? 'dossier card win' : 'dossier card' },
      h('div', { class: 'tab' }, 'Rank ' + row.rank),
      h('div', { class: 'strip' },
        h('span', {}, voteLabel(row.votes)),
        h('span', {}, row.isYou ? 'You' : 'Revealed')
      ),
      ribbon,
      h('div', { class: 'result-top' },
        h('div', {},
          h('p', { class: 'rank' }, '#' + row.rank),
          h('p', { class: 'byline' }, row.name, row.isYou ? h('span', { class: 'youpill' }, 'You') : null)
        ),
        h('div', { class: 'score' },
          row.average == null ? '—' : String(row.average),
          h('small', {}, row.average == null ? 'no score' : 'out of 5')
        )
      ),
      h('p', { class: 'answer' }, row.text)
    );
  });
  var note = null;
  if (rows.length === 0) {
    note = h('p', { class: 'banner-note' }, 'Nobody filed a theory. The truth remains inconveniently missing.');
  } else if (current.loneTheory) {
    note = h('p', { class: 'banner-note' }, 'Only one theory made it in, so there was nothing fair to rate. It stands uncontested.');
  }
  return h('div', { class: 'app' },
    banners(),
    brand(),
    codeBar(current),
    h('h1', {}, 'The board has spoken'),
    h('p', { class: 'lede' }, 'Averages are in. Names are attached. Argue. The host leaks the next one when the table calms down.'),
    claimBanner(current),
    promptCard(current, 'Declassified'),
    note,
    cards,
    current.you.isHost
      ? hostControls(current)
      : h('p', { class: 'wait', style: 'margin-top:16px' }, 'Leave this up. The results stay until the host opens the next conspiracy.'),
    footer()
  );
}

function build() {
  if (!state) return viewHome();
  if (state.phase === 'lobby') return viewLobby(state);
  if (state.phase === 'writing') return viewWriting(state);
  if (state.phase === 'rating') return viewRating(state);
  if (state.phase === 'results') return viewResults(state);
  return h('div', { class: 'app' },
    banners(),
    brand(),
    h('h1', {}, 'This file is unreadable'),
    h('button', { type: 'button', class: 'primary', onclick: leaveGame }, 'Slip out')
  );
}

function render() {
  var focus = document.activeElement;
  var focusId = focus && focus.id;
  var tag = focus && focus.tagName;
  var start = focus && typeof focus.selectionStart === 'number' ? focus.selectionStart : null;
  var end = focus && typeof focus.selectionEnd === 'number' ? focus.selectionEnd : null;
  var y = window.scrollY || 0;
  var toTop = jumpTop;
  jumpTop = false;
  document.title = state ? (state.code + ' · Conspiraparty') : 'Conspiraparty — Field Terminal';
  mount(build());
  if (focusId && (tag === 'INPUT' || tag === 'TEXTAREA')) {
    var next = document.getElementById(focusId);
    if (next) {
      next.focus();
      if (start != null && next.setSelectionRange) {
        try { next.setSelectionRange(start, end); } catch (err) { /* ignore */ }
      }
    }
  }
  window.scrollTo(0, toTop ? 0 : y);
}

setInterval(function () {
  if (socket && socket.readyState === 1) {
    try { socket.send(JSON.stringify({ type: 'ping' })); } catch (err) { /* ignore */ }
  }
}, 25000);

connect();
