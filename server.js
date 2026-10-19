'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const PROMPTS = require('./prompts');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 10;
const ROOM_TTL_MS = 15 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

if (!Array.isArray(PROMPTS) || PROMPTS.length < 12) {
  console.error('Need at least 12 prompts in prompts.js');
  process.exit(1);
}

const rooms = new Map();

function shuffle(list) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy;
}

function makeCode() {
  const bytes = crypto.randomBytes(4);
  let code = '';
  for (let i = 0; i < 4; i += 1) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

function cleanName(raw) {
  const name = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (name.length < 1 || name.length > 16) return '';
  return name;
}

function cleanCode(raw) {
  return String(raw == null ? '' : raw)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 4);
}

function cleanAnswer(raw) {
  const text = String(raw == null ? '' : raw).replace(/\r\n/g, '\n').trim();
  if (text.length < 1 || text.length > 400) return '';
  return text;
}

function createRoom() {
  let code = '';
  for (let i = 0; i < 12; i += 1) {
    const candidate = makeCode();
    if (!rooms.has(candidate)) {
      code = candidate;
      break;
    }
  }
  if (!code) {
    const err = new Error('Could not open a new file. Try again.');
    err.publicMessage = err.message;
    throw err;
  }
  const room = {
    code: code,
    hostId: null,
    phase: 'lobby',
    round: 0,
    prompt: null,
    deck: shuffle(PROMPTS),
    submissions: [],
    players: new Map(),
    nextOrder: 1,
    expireTimer: null,
  };
  rooms.set(code, room);
  return room;
}

function makePlayer(name, room) {
  const player = {
    id: crypto.randomBytes(8).toString('hex'),
    name: name,
    order: room.nextOrder,
    ws: null,
    connected: false,
    answer: null,
    submitted: false,
    ratings: Object.create(null),
    rated: false,
  };
  room.nextOrder += 1;
  return player;
}

function findByName(room, name) {
  const key = name.toLowerCase();
  for (const player of room.players.values()) {
    if (player.name.toLowerCase() === key) return player;
  }
  return null;
}

function livePlayers(room) {
  const list = [];
  for (const player of room.players.values()) {
    if (player.connected) list.push(player);
  }
  return list;
}

function bind(room, player, ws) {
  const prev = player.ws;
  if (prev && prev !== ws) {
    prev._replaced = true;
    try {
      prev.send(JSON.stringify({
        type: 'kicked',
        message: 'Your cover was opened somewhere else. If that was not you, use a different name.',
      }));
    } catch (err) {
      /* socket already gone */
    }
    try { prev.close(); } catch (err) { /* ignore */ }
  }
  player.ws = ws;
  player.connected = true;
  ws._replaced = false;
  ws.roomCode = room.code;
  ws.playerId = player.id;
  if (room.expireTimer) {
    clearTimeout(room.expireTimer);
    room.expireTimer = null;
  }
}

function scheduleExpiry(room) {
  if (!rooms.has(room.code)) return;
  if (room.expireTimer) {
    clearTimeout(room.expireTimer);
    room.expireTimer = null;
  }
  if (livePlayers(room).length > 0) return;
  room.expireTimer = setTimeout(() => {
    const current = rooms.get(room.code);
    if (!current) return;
    if (livePlayers(current).length > 0) return;
    rooms.delete(room.code);
    console.log('burned ' + room.code);
  }, ROOM_TTL_MS);
  if (room.expireTimer.unref) room.expireTimer.unref();
}

function mustRate(room, player) {
  return room.submissions.filter((sub) => sub.playerId !== player.id);
}

function allConnectedSubmitted(room) {
  const live = livePlayers(room);
  if (live.length === 0) return false;
  return live.every((player) => player.submitted);
}

function ratingPhaseComplete(room) {
  const live = livePlayers(room);
  if (live.length === 0) return false;
  return live.every((player) => player.rated || mustRate(room, player).length === 0);
}

function sealAnswers(room) {
  const submissions = [];
  const ordered = Array.from(room.players.values()).sort((a, b) => a.order - b.order);
  for (let i = 0; i < ordered.length; i += 1) {
    const player = ordered[i];
    if (player.submitted && player.answer) {
      submissions.push({
        playerId: player.id,
        name: player.name,
        text: player.answer,
        token: crypto.randomBytes(8).toString('hex'),
      });
    }
  }
  room.submissions = submissions;
  for (const player of room.players.values()) {
    player.ratings = Object.create(null);
    player.rated = submissions.filter((sub) => sub.playerId !== player.id).length === 0;
  }
  room.phase = submissions.length >= 2 ? 'rating' : 'results';
}

function beginWriting(room, prompt) {
  room.phase = 'writing';
  room.round += 1;
  room.prompt = prompt;
  room.submissions = [];
  for (const player of room.players.values()) {
    player.answer = null;
    player.submitted = false;
    player.ratings = Object.create(null);
    player.rated = false;
  }
}

function pickPrompt(room, custom) {
  const text = String(custom == null ? '' : custom).trim();
  if (text) {
    if (text.length > 180) {
      const err = new Error('Keep the custom conspiracy under 180 characters.');
      err.publicMessage = err.message;
      throw err;
    }
    return text;
  }
  if (!room.deck || room.deck.length === 0) room.deck = shuffle(PROMPTS);
  return room.deck.pop();
}

function tally(room) {
  const rows = room.submissions.map((sub) => {
    const votes = [];
    for (const player of room.players.values()) {
      const score = player.ratings && player.ratings[sub.token];
      if (typeof score === 'number') votes.push(score);
    }
    const average = votes.length
      ? votes.reduce((sum, n) => sum + n, 0) / votes.length
      : null;
    return {
      playerId: sub.playerId,
      name: sub.name,
      text: sub.text,
      average: average,
      votes: votes.length,
    };
  });
  rows.sort((a, b) => {
    if (a.average == null && b.average == null) return a.name.localeCompare(b.name);
    if (a.average == null) return 1;
    if (b.average == null) return -1;
    if (b.average !== a.average) return b.average - a.average;
    return a.name.localeCompare(b.name);
  });
  return rows;
}

function view(room, player) {
  const players = Array.from(room.players.values())
    .sort((a, b) => a.order - b.order)
    .map((p) => ({
      name: p.name,
      connected: p.connected,
      submitted: p.submitted,
      rated: !!p.rated,
      isHost: p.id === room.hostId,
      isYou: p.id === player.id,
    }));

  const payload = {
    type: 'state',
    code: room.code,
    phase: room.phase,
    round: room.round,
    prompt: room.phase === 'lobby' ? null : room.prompt,
    you: null,
    players: players,
    yourAnswer: player.submitted ? player.answer : null,
  };
  for (let i = 0; i < players.length; i += 1) {
    if (players[i].isYou) payload.you = players[i];
  }

  if (room.phase === 'rating') {
    payload.ballots = room.submissions
      .filter((sub) => sub.playerId !== player.id)
      .map((sub) => ({
        token: sub.token,
        text: sub.text,
        score: player.ratings[sub.token] || null,
      }))
      .sort((a, b) => a.token.localeCompare(b.token));
  }

  if (room.phase === 'results') {
    const rows = tally(room);
    let top = null;
    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i].average != null && (top == null || rows[i].average > top)) top = rows[i].average;
    }
    payload.loneTheory = room.submissions.length < 2;
    payload.results = rows.map((row) => ({
      name: row.name,
      text: row.text,
      average: row.average == null ? null : Math.round(row.average * 10) / 10,
      votes: row.votes,
      isYou: row.playerId === player.id,
      plausible: !payload.loneTheory && row.average != null && row.average === top,
    }));
  }

  return payload;
}

function send(ws, payload) {
  if (!ws || ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(payload)); } catch (err) { /* ignore */ }
}

function fail(ws, message) {
  send(ws, { type: 'error', message: message });
}

function broadcast(room) {
  for (const player of room.players.values()) {
    if (!player.ws || player.ws.readyState !== 1) continue;
    send(player.ws, view(room, player));
  }
}

function afterMutation(room) {
  if (!room || !rooms.has(room.code)) return;
  if (room.phase === 'writing' && allConnectedSubmitted(room)) sealAnswers(room);
  if (room.phase === 'rating' && ratingPhaseComplete(room)) room.phase = 'results';
  broadcast(room);
  scheduleExpiry(room);
}

function removePlayer(room, player) {
  if (!room.players.has(player.id)) return;
  room.players.delete(player.id);
  if (player.ws) {
    player.ws.roomCode = undefined;
    player.ws.playerId = undefined;
    player.ws = null;
  }
  if (room.players.size === 0) {
    if (room.expireTimer) clearTimeout(room.expireTimer);
    rooms.delete(room.code);
    console.log('closed ' + room.code);
    return;
  }
  if (room.hostId === player.id) {
    const next = Array.from(room.players.values()).sort((a, b) => a.order - b.order);
    let pick = next[0];
    for (let i = 0; i < next.length; i += 1) {
      if (next[i].connected) { pick = next[i]; break; }
    }
    room.hostId = pick.id;
  }
  afterMutation(room);
}

function release(ws) {
  const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
  const player = room && ws.playerId ? room.players.get(ws.playerId) : null;
  if (!room || !player || player.ws !== ws) {
    ws.roomCode = undefined;
    ws.playerId = undefined;
    return;
  }
  player.connected = false;
  removePlayer(room, player);
}

function getCtx(ws) {
  const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
  const player = room && ws.playerId ? room.players.get(ws.playerId) : null;
  if (!room || !player || player.ws !== ws) return null;
  return { room: room, player: player };
}

function onCreate(ws, msg) {
  const name = cleanName(msg.name);
  if (!name) return fail(ws, 'Every operative needs a cover name (1–16 characters).');
  release(ws);
  const room = createRoom();
  const player = makePlayer(name, room);
  room.hostId = player.id;
  room.players.set(player.id, player);
  bind(room, player, ws);
  console.log('opened ' + room.code + ' host=' + player.name);
  afterMutation(room);
}

function onJoin(ws, msg) {
  const name = cleanName(msg.name);
  if (!name) return fail(ws, 'Every operative needs a cover name (1–16 characters).');
  const code = cleanCode(msg.code);
  if (code.length !== 4) return fail(ws, 'Codes are 4 characters. No I, O, 0, or 1.');
  const room = rooms.get(code);
  if (!room) return fail(ws, 'No file under that code. It may have been burned.');

  if (ws.roomCode === code) {
    const already = room.players.get(ws.playerId);
    if (already && already.ws === ws) {
      if (already.name.toLowerCase() !== name.toLowerCase()) {
        return fail(ws, 'You are already in this file under another cover.');
      }
      return send(ws, view(room, already));
    }
  }

  const existing = findByName(room, name);
  if (existing) {
    release(ws);
    if (!rooms.has(code)) return fail(ws, 'No file under that code. It may have been burned.');
    bind(room, existing, ws);
    console.log(existing.name + ' rejoined ' + code);
    return afterMutation(room);
  }

  release(ws);
  if (!rooms.has(code)) return fail(ws, 'No file under that code. It may have been burned.');
  if (room.players.size >= MAX_PLAYERS) {
    return fail(ws, 'This briefing is full. Ten operatives is the fire code.');
  }
  const player = makePlayer(name, room);
  room.players.set(player.id, player);
  bind(room, player, ws);
  console.log(player.name + ' entered ' + code + ' (' + room.players.size + ')');
  afterMutation(room);
}

function onStart(ws, msg) {
  const ctx = getCtx(ws);
  if (!ctx) return fail(ws, 'You are not in a file.');
  const room = ctx.room;
  const player = ctx.player;
  if (room.hostId !== player.id) return fail(ws, 'Only the host can open the next file.');
  if (room.phase !== 'lobby' && room.phase !== 'results') return;
  if (livePlayers(room).length < 2) {
    return fail(ws, 'You need at least two live operatives in the room.');
  }
  let prompt;
  try {
    prompt = pickPrompt(room, msg.prompt);
  } catch (err) {
    return fail(ws, err.publicMessage || 'That conspiracy did not file.');
  }
  beginWriting(room, prompt);
  console.log(room.code + ' round ' + room.round);
  afterMutation(room);
}

function onAnswer(ws, msg) {
  const ctx = getCtx(ws);
  if (!ctx) return fail(ws, 'You are not in a file.');
  const room = ctx.room;
  const player = ctx.player;
  if (room.phase !== 'writing') return fail(ws, 'Theories are closed for this round.');
  if (player.submitted) return send(ws, view(room, player));
  const text = cleanAnswer(msg.text);
  if (!text) return fail(ws, 'Theories need between 1 and 400 characters.');
  player.answer = text;
  player.submitted = true;
  afterMutation(room);
}

function onRate(ws, msg) {
  const ctx = getCtx(ws);
  if (!ctx) return fail(ws, 'You are not in a file.');
  const room = ctx.room;
  const player = ctx.player;
  if (room.phase !== 'rating') return fail(ws, 'Rating is closed.');
  if (player.rated) return send(ws, view(room, player));
  const need = mustRate(room, player);
  if (need.length === 0) {
    player.rated = true;
    return afterMutation(room);
  }
  const scores = msg.scores;
  if (!scores || typeof scores !== 'object' || Array.isArray(scores)) {
    return fail(ws, 'Rate every other theory from 1 to 5. No abstaining.');
  }
  const next = Object.create(null);
  for (let i = 0; i < need.length; i += 1) {
    const value = scores[need[i].token];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5) {
      return fail(ws, 'Rate every other theory from 1 to 5. No abstaining.');
    }
    next[need[i].token] = value;
  }
  player.ratings = next;
  player.rated = true;
  afterMutation(room);
}

function onLock(ws) {
  const ctx = getCtx(ws);
  if (!ctx) return fail(ws, 'You are not in a file.');
  const room = ctx.room;
  const player = ctx.player;
  if (room.hostId !== player.id) return fail(ws, 'Only the host can skip ahead.');
  if (room.phase === 'writing') sealAnswers(room);
  else if (room.phase === 'rating') room.phase = 'results';
  else return;
  afterMutation(room);
}

function onClaim(ws) {
  const ctx = getCtx(ws);
  if (!ctx) return fail(ws, 'You are not in a file.');
  const room = ctx.room;
  const player = ctx.player;
  if (room.hostId === player.id) return send(ws, view(room, player));
  const host = room.players.get(room.hostId);
  if (host && host.connected) return fail(ws, 'The host is still live.');
  room.hostId = player.id;
  console.log(player.name + ' claimed host of ' + room.code);
  afterMutation(room);
}

function handle(ws, msg) {
  if (!msg || typeof msg !== 'object') return;
  const type = msg.type;
  if (type === 'ping') return send(ws, { type: 'pong' });
  if (type === 'create') return onCreate(ws, msg);
  if (type === 'join') return onJoin(ws, msg);
  if (type === 'start') return onStart(ws, msg);
  if (type === 'answer') return onAnswer(ws, msg);
  if (type === 'rate') return onRate(ws, msg);
  if (type === 'lock') return onLock(ws);
  if (type === 'claim') return onClaim(ws);
  if (type === 'leave') return release(ws);
}

function lanAddresses() {
  const found = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    const list = nets[name] || [];
    for (let i = 0; i < list.length; i += 1) {
      const entry = list[i];
      const family = entry.family;
      if ((family === 'IPv4' || family === 4) && !entry.internal) found.push(entry.address);
    }
  }
  return found;
}

function safePublicPath(urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch (err) { return null; }
  if (decoded.indexOf('\0') !== -1) return null;
  const filePath = path.normalize(path.join(PUBLIC_DIR, decoded));
  const rel = path.relative(PUBLIC_DIR, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return filePath;
}

function serveStatic(req, res) {
  const hostUrl = new URL(req.url, 'http://127.0.0.1');
  if (hostUrl.pathname === '/health') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(JSON.stringify({ ok: true, prompts: PROMPTS.length }));
    return;
  }
  let pathname = hostUrl.pathname;
  if (pathname === '/') pathname = '/index.html';
  const filePath = safePublicPath(pathname);
  if (!filePath) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad path');
    return;
  }
  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Missing file');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const cache = ext === '.ttf' ? 'public, max-age=86400' : 'no-cache';
    res.writeHead(req.method === 'HEAD' ? 200 : 200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end('Method not allowed');
    return;
  }
  serveStatic(req, res);
});

const wss = new WebSocketServer({
  server: server,
  path: '/ws',
  maxPayload: 16 * 1024,
  perMessageDeflate: false,
});

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (buf) => {
    if (buf.length > 12000) return;
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch (err) { return; }
    try {
      handle(ws, msg);
    } catch (err) {
      console.error(err);
      fail(ws, 'The file jammed. Try that again.');
    }
  });
  ws.on('close', () => {
    if (ws._replaced) return;
    const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
    const player = room && ws.playerId ? room.players.get(ws.playerId) : null;
    if (!room || !player || player.ws !== ws) return;
    player.connected = false;
    player.ws = null;
    afterMutation(room);
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (err) { /* ignore */ }
  }
}, 30000);
if (heartbeat.unref) heartbeat.unref();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('Port ' + PORT + ' is already in use. Try PORT=3999 npm start');
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Conspiraparty field terminal');
  console.log('  Local:   http://localhost:' + PORT);
  const lans = lanAddresses();
  for (let i = 0; i < lans.length; i += 1) {
    console.log('  Network: http://' + lans[i] + ':' + PORT);
  }
  console.log('Rooms live in memory. Closing this process burns the files.');
  console.log(PROMPTS.length + ' conspiracy cards loaded.');
});
