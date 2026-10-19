# Conspiraparty field terminal

A phone-first party game for [conspiraparty.com](https://www.conspiraparty.com). One person opens a case file, everyone else joins with a short code, and you argue about a ridiculous made-up conspiracy.

Theories stay hidden until the pile is sealed. Then everyone rates the **other** answers from 1 to 5. Results show the theory, the average, and who wrote it, and they stay on screen so the table can argue before the host leaks the next one.

## Run it locally

```bash
cd conspiraparty-game
npm install
npm start
```

One step, after dependencies are installed: `npm start`. `./start.sh` does the install if `ws` is missing, then starts the server.

- **Port:** 3000 (override with `PORT=8080 npm start`)
- **On this computer:** http://localhost:3000
- **On phones:** use the `Network:` URL printed in the terminal. Same Wi-Fi. Do not use `localhost` on a phone; that means the phone itself.

Rooms live in memory. Quit the process and every file is burned. Nothing here opens a public tunnel.

## Create vs join

1. **Host:** open the site, enter a cover name (1–16 characters), tap **Open a new file**. Read the 4-character code out loud. Codes never use I, O, 0, or 1.
2. **Everyone else:** open the same site, enter the same kind of name plus the code, tap **Enter with the code**.
3. **Host:** **Draw a random prompt** (18 baked-in cards) or type a custom conspiracy (180 characters) and run that.
4. Everyone files a theory (400 characters). Nobody sees the other texts yet.
5. When every live player has filed, or the host taps **Lock theories and move on**, the other theories appear for rating. You do not rate your own. Names stay off until the reveal.
6. Results stay up. The host starts the next conspiracy when the argument cools down.

If someone’s phone dies, they can rejoin with the **same code and cover name** and pick up the current phase. A disconnected player does not block the round. The host can also lock/skip. If the host’s signal drops, someone else can **Claim the host file**. Leaving on purpose hands host to the next live player.

Two people should not share a cover name. The second one takes the seat.

## Smoke test

With the server already running:

```bash
npm run smoke
```

That drives two simulated clients through create, join, hidden answers, ratings, results, rejoin, and a host lock.
