'use strict';

const http = require('http');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '127.0.0.1';

const PROMPT = 'The vending machine is laundering quarters.';
const ADA = 'The mailbox is a drop box for garden gnomes.';
const BEA = 'Greg bills the moon rental to facilities.';
const PROMPT_2 = 'Houseplants are on strike.';
const ADA_2 = 'They want dental and a window.';

function assert(cond, message) {
  if (!cond) throw new Error('ASSERT: ' + message);
}

function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: HOST, port: PORT, path: pathname }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
  });
}

class Client {
  constructor(name) {
    this.name = name;
    this.ws = null;
    this.queue = [];
    this.waiters = [];
  }

  connect() {
    const client = this;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://' + HOST + ':' + PORT + '/ws');
      client.ws = ws;
      ws.on('open', () => resolve());
      ws.on('error', (err) => reject(err));
      ws.on('message', (buf) => {
        let msg;
        try { msg = JSON.parse(buf.toString()); } catch (err) { return; }
        if (client.waiters.length) client.waiters.shift()(msg);
        else client.queue.push(msg);
      });
    });
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  nextMessage(timeout) {
    const client = this;
    if (client.queue.length) return Promise.resolve(client.queue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(client.name + ' timed out waiting for a message'));
      }, timeout || 4000);
      client.waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  async until(pred, timeout) {
    const start = Date.now();
    const limit = timeout || 5000;
    while (Date.now() - start < limit) {
      const msg = await this.nextMessage(limit - (Date.now() - start));
      if (msg.type === 'pong' || msg.type === 'ping') continue;
      if (msg.type === 'error') throw new Error(this.name + ' got error: ' + msg.message);
      if (msg.type === 'kicked') throw new Error(this.name + ' was kicked: ' + msg.message);
      if (pred(msg)) return msg;
    }
    throw new Error(this.name + ' condition not met');
  }

  close() {
    const ws = this.ws;
    return new Promise((resolve) => {
      ws.once('close', () => resolve());
      ws.close();
    });
  }
}

function resultByName(state, name) {
  const rows = state.results || [];
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].name === name) return rows[i];
  }
  return null;
}

async function main() {
  const health = await get('/health');
  assert(health.status === 200, 'health status ' + health.status);
  const healthJson = JSON.parse(health.body);
  assert(healthJson.ok === true, 'health not ok');
  assert(healthJson.prompts >= 12, 'fewer than 12 prompts: ' + healthJson.prompts);

  const home = await get('/');
  assert(home.status === 200, 'index status');
  assert(home.body.indexOf('width=device-width') !== -1, 'missing viewport');
  assert(/conspiraparty/i.test(home.body), 'missing brand on the page');

  const css = await get('/styles.css');
  assert(css.status === 200 && css.body.indexOf('Special Elite') !== -1, 'css missing');
  const js = await get('/client.js');
  assert(js.status === 200 && js.body.indexOf('/ws') !== -1, 'client missing');

  const ada = new Client('Ada');
  const bea = new Client('Bea');
  await ada.connect();
  await bea.connect();
  ada.send('%%%');
  ada.send({ type: 'create', name: 'Ada' });
  const created = await ada.until((msg) => msg.type === 'state' && msg.phase === 'lobby');
  assert(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/.test(created.code), 'bad code ' + created.code);
  assert(created.you && created.you.isHost, 'creator is not host');
  assert(!created.prompt, 'lobby leaked a prompt');
  assert(!created.ballots && !created.results, 'lobby leaked round data');

  bea.send({ type: 'join', code: created.code.toLowerCase(), name: 'Bea' });
  const beaLobby = await bea.until((msg) => msg.type === 'state' && msg.players.length === 2);
  const adaLobby = await ada.until((msg) => msg.type === 'state' && msg.players.length === 2);
  assert(beaLobby.code === created.code, 'join code mismatch');
  assert(beaLobby.you && !beaLobby.you.isHost, 'joiner became host');
  assert(adaLobby.players.length === 2, 'host did not see the guest');

  ada.send({ type: 'start', prompt: PROMPT });
  const adaWriting = await ada.until((msg) => msg.phase === 'writing');
  const beaWriting = await bea.until((msg) => msg.phase === 'writing');
  assert(adaWriting.prompt === PROMPT, 'host prompt mismatch');
  assert(beaWriting.prompt === PROMPT, 'guest prompt mismatch');
  assert(adaWriting.round === 1, 'round did not start at 1');
  assert(!adaWriting.ballots && !adaWriting.results, 'writing leaked ratings');

  ada.send({ type: 'answer', text: ADA });
  const beaHidden = await bea.until((msg) => {
    return msg.phase === 'writing' && msg.players.some((p) => p.name === 'Ada' && p.submitted);
  });
  assert(beaHidden.yourAnswer == null, 'Bea was shown an answer before filing');
  assert(JSON.stringify(beaHidden).indexOf(ADA) === -1, 'Bea saw Ada’s theory before the pile was sealed');
  assert(!beaHidden.ballots && !beaHidden.results, 'writing state included reveal payload');

  bea.send({ type: 'answer', text: BEA });
  const adaRate = await ada.until((msg) => msg.phase === 'rating');
  const beaRate = await bea.until((msg) => msg.phase === 'rating');
  assert(adaRate.ballots.length === 1, 'Ada should rate exactly one theory');
  assert(beaRate.ballots.length === 1, 'Bea should rate exactly one theory');
  assert(adaRate.ballots[0].text === BEA, 'Ada did not see Bea’s theory');
  assert(beaRate.ballots[0].text === ADA, 'Bea did not see Ada’s theory');
  assert(JSON.stringify(adaRate.ballots).indexOf(ADA) === -1, 'Ada was asked to rate her own theory');
  assert(JSON.stringify(beaRate.ballots).indexOf('Ada') === -1, 'ballot leaked a name');
  assert(JSON.stringify(adaRate.ballots).indexOf('Bea') === -1, 'ballot leaked a name');
  Object.keys(adaRate.ballots[0]).forEach((key) => {
    assert(['token', 'text', 'score'].indexOf(key) !== -1, 'unexpected ballot field ' + key);
  });

  ada.send({ type: 'rate', scores: { [adaRate.ballots[0].token]: 5 } });
  bea.send({ type: 'rate', scores: { [beaRate.ballots[0].token]: 2 } });
  const adaResults = await ada.until((msg) => msg.phase === 'results');
  const beaResults = await bea.until((msg) => msg.phase === 'results');
  assert(adaResults.prompt === PROMPT, 'results dropped the prompt');
  const adaRow = resultByName(adaResults, 'Ada');
  const beaRow = resultByName(adaResults, 'Bea');
  assert(adaRow && beaRow, 'results missing an author');
  assert(adaRow.text === ADA && beaRow.text === BEA, 'result text mismatch');
  assert(adaRow.average === 2 && adaRow.votes === 1, 'Ada average wrong ' + JSON.stringify(adaRow));
  assert(beaRow.average === 5 && beaRow.votes === 1, 'Bea average wrong ' + JSON.stringify(beaRow));
  assert(beaRow.plausible === true && adaRow.plausible === false, 'winner flag wrong');
  assert(adaRow.isYou === true && beaRow.isYou === false, 'isYou wrong for Ada');
  assert(resultByName(beaResults, 'Bea').isYou === true, 'isYou wrong for Bea');
  assert(resultByName(beaResults, 'Ada').average === 2, 'Bea saw a different average');

  await bea.close();
  const beaAgain = new Client('Bea-rejoin');
  await beaAgain.connect();
  beaAgain.send({ type: 'join', code: created.code, name: 'Bea' });
  const rejoined = await beaAgain.until((msg) => msg.phase === 'results' && msg.you && msg.you.name === 'Bea');
  assert(rejoined.you.connected === true, 'rejoin did not mark Bea live');
  assert(resultByName(rejoined, 'Ada').text === ADA, 'rejoin lost Ada’s theory');
  assert(resultByName(rejoined, 'Bea').text === BEA, 'rejoin lost Bea’s theory');
  assert(!rejoined.you.isHost, 'rejoin stole the host');
  const adaSawRejoin = await ada.until((msg) => msg.players.some((p) => p.name === 'Bea' && p.connected));
  assert(adaSawRejoin.phase === 'results', 'results did not stay up while someone rejoined');

  const ada2 = new Client('Ada2');
  const bea2 = new Client('Bea2');
  await ada2.connect();
  await bea2.connect();
  ada2.send({ type: 'create', name: 'Ada' });
  const room2 = await ada2.until((msg) => msg.phase === 'lobby');
  bea2.send({ type: 'join', code: room2.code, name: 'Bea' });
  await bea2.until((msg) => msg.players.length === 2);
  ada2.send({ type: 'start', prompt: PROMPT_2 });
  await ada2.until((msg) => msg.phase === 'writing' && msg.prompt === PROMPT_2);
  await bea2.until((msg) => msg.phase === 'writing');
  ada2.send({ type: 'answer', text: ADA_2 });
  const stillWriting = await bea2.until((msg) => msg.phase === 'writing' && msg.players.some((p) => p.submitted));
  assert(JSON.stringify(stillWriting).indexOf(ADA_2) === -1, 'lock setup leaked the theory early');
  ada2.send({ type: 'lock' });
  const locked = await ada2.until((msg) => msg.phase === 'results');
  const lockedBea = await bea2.until((msg) => msg.phase === 'results');
  assert(locked.loneTheory === true, 'one theory should skip rating');
  assert(locked.results.length === 1, 'expected a single result');
  assert(locked.results[0].name === 'Ada' && locked.results[0].text === ADA_2, 'locked result mismatch');
  assert(locked.results[0].average == null, 'unrated lone theory should have no average');
  assert(lockedBea.results.length === 1 && lockedBea.prompt === PROMPT_2, 'guest did not get the locked reveal');

  const stillUp = await get('/health');
  assert(stillUp.status === 200, 'server died during the smoke test');

  await ada.close();
  await beaAgain.close();
  await ada2.close();
  await bea2.close();

  console.log('SMOKE OK');
  console.log('port ' + PORT);
  console.log('prompts ' + healthJson.prompts);
  console.log('room ' + created.code + ' create/join/answer/rate/results');
  console.log('hidden while writing: other theories were not in the payload');
  console.log('results: Ada 2, Bea 5, names attached, plausible=' + beaRow.name);
  console.log('rejoin: Bea restored on ' + created.code + ' with results still up');
  console.log('host lock: stuck room advanced to a one-theory reveal');
}

main().catch((err) => {
  console.error('SMOKE FAIL');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
