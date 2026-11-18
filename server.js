"use strict";
// Zombie Street — serveur multijoueur (autoritaire : physique, zombies, dégâts, vagues)
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const WW = 6400, GY = 455, TICK = 50, DT = TICK / 1000, MAXZ = 10;
const WN = ["Beretta M9", "MAC-10", "AK-47", "Benelli M3", "Dragunov SVD"];
const WP = [
  { dmg: 20, rt: .28, pel: 1, sp: .015, v: 1100, pr: 0, lf: 1, f: 520 },
  { dmg: 9,  rt: .08, pel: 1, sp: .06,  v: 1100, pr: 0, lf: 1, f: 380 },
  { dmg: 18, rt: .11, pel: 1, sp: .03,  v: 1300, pr: 0, lf: 1, f: 300 },
  { dmg: 11, rt: .8,  pel: 7, sp: .18,  v: 1000, pr: 0, lf: .35, f: 200 },
  { dmg: 70, rt: .9,  pel: 1, sp: 0,     v: 2600, pr: 3, lf: 1, f: 150 },
];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const html = fs.readFileSync(path.join(__dirname, "index.html"));

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, players: players.size, wave, uptime: Math.round(process.uptime()) }));
  } else if (req.url === "/" || req.url.startsWith("/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(html);
  } else { res.writeHead(404); res.end("Not found"); }
});
const wss = new WebSocketServer({ server });

// état du monde partagé
const players = new Map();
let zombies = [], bullets = [], items = [], ev = [];
let wave = 0, left = 0, spT = 0, ww = 2.5, ph = "play", ot = 0, best = 0;
let nid = 1, zid = 1, iid = 1;

const unlocked = () => Math.max(1, Math.min(5, wave));
const alivePlayers = () => [...players.values()].filter(p => !p.dead);

function spawnAt(p) {
  const al = alivePlayers().filter(q => q !== p);
  const ref = al.length ? al[(Math.random() * al.length) | 0] : null;
  p.x = ref ? clamp(ref.x + (Math.random() < .5 ? -1 : 1) * 90, 60, WW - 60) : WW / 2;
  p.y = 0; p.vy = 0; p.dead = 0; p.hp = 100; p.inv = 0; p.air = 0;
}

wss.on("connection", ws => {
  ws.on("error", () => {});
  const id = nid++;
  const p = { id, ws, x: WW / 2, y: 0, vy: 0, dir: 1, hp: 100, dead: 0, inv: 0, fire: 0, shot: 0, air: 0,
              mv: 0, wp: 0, score: 0, kills: 0, in: { l: 0, r: 0, j: 0, f: 0 } };
  spawnAt(p);
  players.set(id, p);
  ws.send(JSON.stringify({ t: "hello", id }));
  ws.on("message", raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || m.t !== "in") return;
    p.in = { l: m.l ? 1 : 0, r: m.r ? 1 : 0, j: m.j ? 1 : 0, f: m.f ? 1 : 0 };
    p.wp = clamp(m.w | 0, 0, unlocked() - 1);
  });
  ws.on("close", () => players.delete(id));
});

function nextWave() {
  wave++;
  const n = Math.max(1, players.size);
  left = Math.round((5 + wave * 4) * (1 + .35 * (n - 1)));
  spT = 1.5; ww = 2.5;
  for (const p of players.values()) if (!p.dead && wave > 1) p.hp = Math.min(100, p.hp + 20);
  ev.push({ ev: "ann", s: wave <= 5 ? "Vague " + wave + " · nouvelle arme : " + WN[wave - 1] : "Vague " + wave });
}

function spawn() {
  const al = alivePlayers();
  if (!al.length) return;
  const ref = al[(Math.random() * al.length) | 0];
  const side = Math.random() < .5 ? -1 : 1;
  const x = clamp(ref.x + side * (560 + Math.random() * 120), -40, WW + 40);
  const wild = wave >= 2 && Math.random() < Math.min(.55, .15 + wave * .07);
  const type = wild ? "wild" : Math.random() < .5 ? "man" : "woman";
  zombies.push({ id: zid++, type, wild, x, hp: (wild ? 30 : 45) * (1 + wave * .07),
                 sp: (wild ? 120 : 48) + Math.random() * 20 + wave * 3,
                 st: "w", cd: 0, at: 0, did: 0, hit: 0, dead: 0, t: Math.random() * 2, dir: 1 });
}

function hurt(p, d) {
  if (p.inv > 0 || p.dead) return;
  p.hp -= d; p.inv = .45;
  ev.push({ ev: "hurt", id: p.id, x: p.x, y: GY - 55 });
  if (p.hp <= 0) { p.hp = 0; p.dead = .001; }
}

function hitZ(z, d, dir, own) {
  z.hp -= d; z.hit = .12; z.x += dir * 3;
  ev.push({ ev: "hit", x: z.x, y: GY - 55, dir });
  if (z.hp <= 0 && !z.dead) {
    z.dead = .001; z.t = 0;
    const o = players.get(own);
    if (o) { o.kills++; o.score += z.wild ? 15 : 10; }
    ev.push({ ev: "kill", x: z.x, y: GY - 55, dir });
    if (Math.random() < .12) items.push({ id: iid++, x: z.x });
  }
}

function shoot(p) {
  const w = WP[p.wp];
  p.fire = w.rt; p.shot = .14;
  const mx = p.x + p.dir * 49, my = GY - p.y - 55;
  for (let i = 0; i < w.pel; i++) {
    const a = (Math.random() - .5) * w.sp * 2;
    bullets.push({ x: mx, y: my, vx: p.dir * w.v * Math.cos(a), vy: w.v * Math.sin(a),
                   d: w.dmg, pr: w.pr, life: w.lf, hit: [], own: p.id, th: w.pel > 1 ? 1 : 2 });
  }
  ev.push({ ev: "shot", id: p.id, f: w.f });
}

function updateZombies() {
  const al = alivePlayers();
  for (const z of zombies) {
    if (z.dead) { z.dead += DT; z.t += DT; continue; }
    z.t += DT; z.hit -= DT;
    if (!al.length) continue;
    let tg = al[0], bd = Infinity;
    for (const p of al) { const dd = Math.abs(p.x - z.x); if (dd < bd) { bd = dd; tg = p; } }
    const d = tg.x - z.x, dist = Math.abs(d);
    z.dir = d >= 0 ? 1 : -1;
    if (z.st === "a") {
      z.at += DT;
      if (!z.did && z.at > .3) { z.did = 1; if (dist < 62 && tg.y < 45) hurt(tg, z.wild ? 7 : 10); }
      if (z.at > .55) { z.st = "w"; z.did = 0; z.cd = .5; z.t = 0; }
    } else {
      z.cd -= DT;
      if (dist < 46 && z.cd <= 0 && tg.y < 45) { z.st = "a"; z.at = 0; z.t = 0; }
      else if (dist > 34) z.x += z.dir * z.sp * DT;
    }
  }
  zombies = zombies.filter(z => z.dead < 4);
}

function update() {
  if (!players.size) return;
  if (wave === 0) nextWave();
  const list = [...players.values()];

  for (const p of list) {
    if (p.dead) {
      p.dead += DT;
      if (p.dead > 3 && ph === "play") spawnAt(p);
      continue;
    }
    p.inv = Math.max(0, p.inv - DT); p.fire -= DT; p.shot -= DT;
    const ax = (p.in.r ? 1 : 0) - (p.in.l ? 1 : 0);
    p.mv = ax;
    p.x = clamp(p.x + ax * 260 * DT, 40, WW - 40);
    if (ax) p.dir = ax;
    if (p.in.j && p.y === 0 && p.vy <= 0) p.vy = 820;
    p.vy -= 2300 * DT;
    p.y = Math.max(0, p.y + p.vy * DT);
    if (p.y === 0 && p.vy < 0) p.vy = 0;
    p.air = p.y > 0 ? p.air + DT : 0;
    if (p.in.f && p.fire <= 0) shoot(p);
  }

  for (const i of items) {
    if (i.got) continue;
    for (const p of list) {
      if (!p.dead && Math.abs(i.x - p.x) < 35 && p.y < 50) {
        i.got = 1; p.hp = Math.min(100, p.hp + 25); ev.push({ ev: "pick" }); break;
      }
    }
  }
  items = items.filter(i => !i.got);

  updateZombies();

  for (const b of bullets) {
    b.life -= DT;
    for (let s = 0; s < 2 && b.life > 0; s++) {
      b.x += b.vx * DT / 2; b.y += b.vy * DT / 2;
      for (const z of zombies) {
        if (z.dead || b.hit.includes(z)) continue;
        if (Math.abs(b.x - z.x) < 24 && b.y > GY - 100 && b.y < GY - 2) {
          b.hit.push(z);
          hitZ(z, b.d, Math.sign(b.vx), b.own);
          if (--b.pr < 0) { b.life = 0; break; }
        }
      }
    }
  }
  bullets = bullets.filter(b => b.life > 0 && b.x > -100 && b.x < WW + 100);

  const alive = list.filter(p => !p.dead).length;
  const zAlive = zombies.filter(z => !z.dead).length;
  if (alive > 0) {
    if (left > 0 && zAlive < MAXZ + 3 * (alive - 1)) {
      spT -= DT;
      if (spT <= 0) { spawn(); left--; spT = Math.max(.45, 1.6 - wave * .1); }
    }
    if (left === 0 && zAlive === 0) { ww -= DT; if (ww <= 0) nextWave(); }
  } else {
    ph = "over"; ot = 6;
    best = Math.max(best, list.reduce((a, p) => a + p.score, 0));
    ev.push({ ev: "ann", s: "Partie terminée" });
  }
}

function restart() {
  wave = 0; zombies = []; bullets = []; items = [];
  for (const p of players.values()) { p.score = 0; p.kills = 0; p.wp = 0; spawnAt(p); }
  ph = "play";
  ev.push({ ev: "ann", s: "Nouvelle manche" });
}

function broadcast() {
  const msg = JSON.stringify({
    t: "s", wave, left, ph, best, ot: +ot.toFixed(1),
    alive: zombies.filter(z => !z.dead).length,
    p: [...players.values()].map(p => ({
      id: p.id, name: "Joueur " + p.id,
      x: +p.x.toFixed(1), y: +p.y.toFixed(1), vy: +p.vy.toFixed(1), dir: p.dir,
      hp: Math.ceil(p.hp), dead: +p.dead.toFixed(2), inv: +p.inv.toFixed(2),
      shot: +p.shot.toFixed(2), air: +p.air.toFixed(2), mv: p.mv, wp: p.wp,
      score: p.score, kills: p.kills,
    })),
    z: zombies.map(z => ({ id: z.id, type: z.type, x: +z.x.toFixed(1), dir: z.dir, st: z.st,
                           at: +z.at.toFixed(2), dead: +z.dead.toFixed(2), hit: +z.hit.toFixed(2) })),
    b: bullets.map(b => ({ x: +b.x.toFixed(1), y: +b.y.toFixed(1), s: Math.sign(b.vx), th: b.th })),
    i: items.map(i => ({ id: i.id, x: i.x })),
    ev,
  });
  ev = [];
  for (const p of players.values()) if (p.ws.readyState === 1) p.ws.send(msg);
}

function tick() {
  if (ph === "over") { ot -= DT; if (ot <= 0) restart(); }
  else update();
  broadcast();
}

setInterval(tick, TICK);
server.listen(PORT, "0.0.0.0", () => console.log("Zombie Street multijoueur sur le port " + PORT));
process.on("SIGTERM", () => { server.close(); process.exit(0); });
