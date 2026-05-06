// Skyline Stacker - single-player HTML5 prototype
// Physics via Matter.js. Graphics via canvas (procedural, no external assets).

const { Engine, World, Bodies, Body, Events, Composite } = Matter;

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const W = canvas.width, H = canvas.height;

// ---------- Floor types ----------
const FLOORS = {
  lobby:      { name: 'Lobby',       w: 180, h: 38, cost: 6000,  rent: 0,  color: '#c9a96a', windows: 'door' },
  apartments: { name: 'Apartments',  w: 140, h: 32, cost: 8000,  rent: 60, color: '#7aa6d8', windows: 'grid' },
  offices:    { name: 'Offices',     w: 150, h: 30, cost: 12000, rent: 95, color: '#5fb59a', windows: 'strip' },
  penthouse:  { name: 'Penthouse',   w: 120, h: 36, cost: 22000, rent: 220,color: '#d8b86a', windows: 'tall', minFloor: 8 },
  mechanical: { name: 'Mechanical',  w: 130, h: 22, cost: 4000,  rent: 0,  color: '#5a6a8a', windows: 'vent', stabilize: 3 },
};
const TYPES = Object.keys(FLOORS);

// ---------- Districts (levels) ----------
const DISTRICTS = [
  { name: 'Suburb',    target: 200000,  windMax: 0.35, quakeChance: 0.0006 },
  { name: 'Downtown',  target: 500000,  windMax: 0.7,  quakeChance: 0.0012 },
  { name: 'Coastal',   target: 900000,  windMax: 1.1,  quakeChance: 0.0010 },
  { name: 'Fault Line',target: 1500000, windMax: 0.8,  quakeChance: 0.0030 },
];

// ---------- Game state ----------
let engine, world;
let groundBody;
let placedFloors = []; // {body, type, def, rentPerSec}
let droppingFloors = []; // floors mid-flight after Space, before they settle
let fallingFloor = null; // {body, type, def}
let cash = 50000;
let rentPerSec = 0;
let districtIdx = 0;
let wind = 0; // current wind force
let windAccum = 0;
let windActive = 0; // time remaining for active gust
let quakeTimer = 0;
let toppledFloors = 0;
let running = false;
let lastTime = 0;
let tiltDeg = 0;
let nextType = 'lobby'; // first floor must be lobby
let started = false;

// Visual state
let stars = [];
let cloudOffset = 0;
let toast = null; // { text, color, t }
let cameraY = 0; // how far camera has scrolled up (positive = scrolled up)
let cameraTargetY = 0;
let shake = 0; // screen shake intensity in seconds remaining
let combo = 0; // consecutive non-sloppy landings

// ---------- Helpers ----------
function $(id) { return document.getElementById(id); }
function fmt(n) { return '$' + Math.round(n).toLocaleString(); }

function pickNextType() {
  if (placedFloors.length === 0) return 'lobby';
  const pool = ['apartments', 'apartments', 'offices', 'offices', 'mechanical'];
  if (placedFloors.length >= 8) pool.push('penthouse', 'penthouse');
  return pool[Math.floor(Math.random() * pool.length)];
}

function buildStars() {
  stars = [];
  for (let i = 0; i < 80; i++) {
    stars.push({ x: Math.random()*W, y: Math.random()*H*0.55, r: Math.random()*1.4+0.2, a: Math.random()*0.7+0.2 });
  }
}

// ---------- Setup ----------
function initEngine() {
  if (engine) Engine.clear(engine);
  engine = Engine.create();
  engine.gravity.y = 1.0;
  world = engine.world;

  // ground
  groundBody = Bodies.rectangle(W/2, H - 20, W, 40, {
    isStatic: true,
    label: 'ground',
    render: { fillStyle: '#2a1f15' }
  });
  World.add(world, groundBody);

  placedFloors = [];
  droppingFloors = [];
  fallingFloor = null;
  cameraY = 0; cameraTargetY = 0; shake = 0; combo = 0;
  cash = 50000;
  rentPerSec = 0;
  wind = 0; windAccum = 0; windActive = 0;
  quakeTimer = 0; toppledFloors = 0;
  tiltDeg = 0;
  nextType = 'lobby';

  Events.on(engine, 'afterUpdate', enforceWorldBounds);
}

function enforceWorldBounds() {
  // Remove floors that fell off-screen
  for (let i = placedFloors.length - 1; i >= 0; i--) {
    const f = placedFloors[i];
    if (f.body.position.y > H + 100 || f.body.position.x < -200 || f.body.position.x > W + 200) {
      World.remove(world, f.body);
      placedFloors.splice(i, 1);
      toppledFloors++;
      rentPerSec = placedFloors.reduce((s, ff) => s + ff.rentPerSec, 0);
    }
  }
  if (fallingFloor && fallingFloor.body.position.y > H + 100) {
    World.remove(world, fallingFloor.body);
    fallingFloor = null;
  }
  for (let i = droppingFloors.length - 1; i >= 0; i--) {
    const f = droppingFloors[i];
    const off = f.body.position.y > H + 100
             || f.body.position.x < -150 || f.body.position.x > W + 150;
    if (off) {
      World.remove(world, f.body);
      droppingFloors.splice(i, 1);
      const refund = Math.round(f.def.cost * 0.5);
      cash += refund;
      combo = 0;
      toast = { text: `BLOWN AWAY! +${fmt(refund)} scrap`, color: '#ff8866', t: 1.6 };
      if (running && !fallingFloor) {
        nextType = pickNextType();
        spawnFalling(nextType);
      }
    }
  }
}

// ---------- Spawning ----------
function spawnFalling(type) {
  const def = FLOORS[type];
  // Suspend at top by giving it gentle fall start
  const spawnY = cameraY + 60;
  const body = Bodies.rectangle(W/2, spawnY, def.w, def.h, {
    friction: 0.9,
    frictionStatic: 1.5,
    density: 0.002,
    restitution: 0.02,
    label: 'falling',
  });
  // Lock rotation while falling so it stays flat and easy to aim
  Body.setInertia(body, Infinity);
  Body.setVelocity(body, { x: 0, y: 0 });
  body.gravityScale = 0; // we handle falling ourselves for a smooth, capped descent
  World.add(world, body);
  fallingFloor = { body, type, def, targetX: W/2, fallSpeed: 0.6, dropped: false };
  updateHUD();
}

function dropFalling() {
  if (!fallingFloor || fallingFloor.dropped) return;
  fallingFloor.dropped = true;
  // restore real physics: rotation + gravity for the impact
  Body.setInertia(fallingFloor.body, fallingFloor.body.mass * 1000);
  fallingFloor.body.gravityScale = 0.55;
  Body.setVelocity(fallingFloor.body, { x: 0, y: 1.4 });
  // pay cost
  cash -= fallingFloor.def.cost;
  const f = fallingFloor;
  droppingFloors.push(f);
  fallingFloor = null;
  const checkLanded = () => {
    // Bail if enforceWorldBounds already cleaned this body up
    if (droppingFloors.indexOf(f) === -1) return;
    const v = f.body.velocity;
    const av = Math.abs(f.body.angularVelocity);
    const speed = Math.hypot(v.x, v.y);
    const idx = droppingFloors.indexOf(f);
    const settled = speed < 0.3 && av < 0.05;
    const groundY = H - 40; // top of street
    const onGround = f.body.position.y + f.def.h/2 > groundY - 4;
    if (settled) {
      if (idx !== -1) droppingFloors.splice(idx, 1);
      // Lobby is the foundation — it MUST sit on the ground.
      // Any other floor on the ground = missed the tower.
      const isFoundation = placedFloors.length === 0 && f.type === 'lobby';
      if (onGround && !isFoundation) {
        // Missed: remove body, refund half the cost as scrap value, show toast
        World.remove(world, f.body);
        const refund = Math.round(f.def.cost * 0.5);
        cash += refund;
        combo = 0;
        toast = { text: `MISSED! +${fmt(refund)} scrap`, color: '#ff8866', t: 1.6 };
        if (running) {
          nextType = pickNextType();
          spawnFalling(nextType);
        }
      } else {
        // Score alignment with the floor below
        let bonus = 0;
        if (placedFloors.length > 0) {
          const below = placedFloors[placedFloors.length - 1];
          const dx = Math.abs(f.body.position.x - below.body.position.x);
          const tolerance = Math.min(f.def.w, below.def.w) / 2;
          const accuracy = 1 - Math.min(1, dx / tolerance);
          if (accuracy > 0.92) {
            combo++;
            bonus = Math.round(f.def.cost * 0.4) + combo * 500;
            toast = { text: `PERFECT! +${fmt(bonus)} (combo x${combo})`, color: '#9ef', t: 1.4 };
          } else if (accuracy > 0.6) {
            combo++;
            bonus = Math.round(f.def.cost * 0.15);
            toast = { text: `GOOD +${fmt(bonus)}`, color: '#8f8', t: 1.1 };
          } else {
            combo = 0;
            toast = { text: 'SLOPPY', color: '#fc6', t: 1.0 };
          }
          cash += bonus;
        }
        // Make placed floors heavier + grippier so collisions don't slide them around.
        if (placedFloors.length === 0 && f.type === 'lobby') {
          Body.setStatic(f.body, true);
        } else {
          f.body.friction = 1.0;
          f.body.frictionStatic = 2.5;
          Body.setDensity(f.body, 0.01);
          // Reset to flat: a well-placed floor should rest level.
          // Quakes/wind can still rotate it later via applied forces.
          Body.setAngle(f.body, 0);
          Body.setAngularVelocity(f.body, 0);
          Body.setVelocity(f.body, { x: 0, y: 0 });
        }
        placedFloors.push({
          body: f.body, type: f.type, def: f.def, rentPerSec: f.def.rent,
        });
        rentPerSec = placedFloors.reduce((s, ff) => s + ff.rentPerSec, 0);
        // Push camera up if tower top is getting near the upper edge of view
        const topY = Math.min(...placedFloors.map(p => p.body.position.y - p.def.h/2));
        const desiredTopMargin = 220;
        if (topY - cameraY < desiredTopMargin) {
          cameraTargetY = topY - desiredTopMargin;
        }
        if (running) {
          nextType = pickNextType();
          spawnFalling(nextType);
        }
      }
      updateHUD();
    } else if (f.body.position.y > H + 50) {
      if (idx !== -1) droppingFloors.splice(idx, 1);
      // Fell off the screen — also spawn next so the game continues
      if (running && !fallingFloor) {
        nextType = pickNextType();
        spawnFalling(nextType);
      }
    } else {
      setTimeout(checkLanded, 120);
    }
  };
  setTimeout(checkLanded, 600);
  updateHUD();
}

function cycleType() {
  if (!fallingFloor || placedFloors.length === 0) return;
  cash -= 500;
  World.remove(world, fallingFloor.body);
  // pick next non-lobby
  const pool = ['apartments', 'offices', 'mechanical'];
  if (placedFloors.length >= 8) pool.push('penthouse');
  let t;
  do { t = pool[Math.floor(Math.random()*pool.length)]; } while (t === fallingFloor.type);
  spawnFalling(t);
}

function nudge(dir) {
  if (!fallingFloor || fallingFloor.dropped) return;
  const margin = fallingFloor.def.w/2 + 10;
  fallingFloor.targetX = Math.max(margin, Math.min(W - margin, fallingFloor.targetX + dir * 24));
}

// ---------- Wind & Quake ----------
function updateForces(dt) {
  const dist = DISTRICTS[districtIdx];
  windAccum += dt;
  if (windActive > 0) {
    windActive -= dt;
    // Wind only affects airborne floors (not the placed tower)
    if (fallingFloor && !fallingFloor.dropped) {
      // pre-drop floor: shove its target sideways so the player visibly fights the gust
      const margin = fallingFloor.def.w/2 + 10;
      fallingFloor.targetX = Math.max(margin,
        Math.min(W - margin, fallingFloor.targetX + wind * 55 * dt));
    }
    for (const f of droppingFloors) {
      // Skip wind on floors close to landing — gives a "magnetic" final approach.
      const top = placedFloors.length ? placedFloors[placedFloors.length - 1] : null;
      const closeToLanding = top
        && f.body.position.y > top.body.position.y - top.def.h/2 - 60
        && Math.abs(f.body.position.x - top.body.position.x) < (top.def.w + f.def.w) / 2;
      if (closeToLanding) {
        Body.setVelocity(f.body, { x: 0, y: f.body.velocity.y });
        continue;
      }
      // Force scales with sqrt(mass) so light floors don't fly off uncontrollably.
      const k = 0.0018 * Math.sqrt(f.body.mass);
      Body.applyForce(f.body, f.body.position, { x: wind * k, y: 0 });
    }
  } else if (windAccum > 8 + Math.random() * 8) {
    windAccum = 0;
    wind = (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * dist.windMax * 2);
    windActive = 2 + Math.random() * 2;
  }

  // Quake
  if (Math.random() < dist.quakeChance * dt * 60) {
    triggerQuake();
  }
  quakeTimer = Math.max(0, quakeTimer - dt);
}

function triggerQuake() {
  quakeTimer = 1.5;
  shake = 0.6;
  toast = { text: 'EARTHQUAKE!', color: '#f86', t: 1.2 };
  for (const f of placedFloors) {
    const jolt = (Math.random() - 0.5) * 0.04;
    Body.applyForce(f.body, f.body.position, { x: jolt * f.body.mass, y: -0.001 * f.body.mass });
    Body.setAngularVelocity(f.body, f.body.angularVelocity + (Math.random()-0.5)*0.05);
  }
}

// ---------- Tilt calc ----------
function computeTilt() {
  if (placedFloors.length < 2) return 0;
  const top = placedFloors[placedFloors.length - 1];
  const base = placedFloors[0];
  const dx = top.body.position.x - base.body.position.x;
  const dy = base.body.position.y - top.body.position.y;
  if (dy < 1) return 0;
  return Math.atan2(dx, dy) * 180 / Math.PI;
}

// ---------- HUD ----------
function updateHUD() {
  $('cash').textContent = fmt(cash);
  $('rent').textContent = fmt(rentPerSec);
  $('floors').textContent = placedFloors.length;
  $('tilt').textContent = Math.abs(tiltDeg).toFixed(1) + '°';
  const dist = DISTRICTS[districtIdx];
  $('target').textContent = fmt(dist.target);
  $('district').textContent = dist.name;

  if (fallingFloor) {
    $('nextName').textContent = fallingFloor.def.name;
    $('nextCost').textContent = fmt(fallingFloor.def.cost);
  }
  const windPct = Math.min(100, (Math.abs(wind) / 1.5) * 100);
  $('windbar').style.width = windPct + '%';
  $('quakebar').style.width = (quakeTimer / 1.5 * 100) + '%';
}

// ---------- Rendering ----------
function drawSky() {
  // gradient sky already on body; canvas overlay for stars + sun + clouds
  ctx.clearRect(0, 0, W, H);

  // sky gradient
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#0c1226');
  sky.addColorStop(0.5, '#3a4a7a');
  sky.addColorStop(1, '#e8a866');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // stars
  for (const s of stars) {
    ctx.globalAlpha = s.a;
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI*2); ctx.fill();
  }
  ctx.globalAlpha = 1;

  // sun
  const sg = ctx.createRadialGradient(W*0.78, H*0.55, 5, W*0.78, H*0.55, 90);
  sg.addColorStop(0, '#ffd76b'); sg.addColorStop(1, 'rgba(255,180,90,0)');
  ctx.fillStyle = sg;
  ctx.beginPath(); ctx.arc(W*0.78, H*0.55, 90, 0, Math.PI*2); ctx.fill();

  // distant skyline silhouette
  ctx.fillStyle = 'rgba(20, 24, 50, 0.7)';
  for (let i = 0; i < 18; i++) {
    const bx = i * 55 - 20;
    const bh = 40 + (Math.sin(i*1.3) + 1) * 30;
    ctx.fillRect(bx, H - 40 - bh, 50, bh);
  }

  // clouds
  cloudOffset = (cloudOffset + 0.2) % (W + 200);
  drawCloud(cloudOffset - 100, 80, 0.6);
  drawCloud((cloudOffset + 350) % (W+200) - 100, 140, 0.4);
  drawCloud((cloudOffset + 600) % (W+200) - 100, 60, 0.5);
}

function drawCloud(x, y, alpha) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(x, y, 18, 0, Math.PI*2);
  ctx.arc(x+20, y-5, 22, 0, Math.PI*2);
  ctx.arc(x+45, y, 18, 0, Math.PI*2);
  ctx.arc(x+25, y+8, 16, 0, Math.PI*2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawGround() {
  // street
  ctx.fillStyle = '#2a1f15';
  ctx.fillRect(0, H - 40, W, 40);
  ctx.fillStyle = '#3d2e20';
  ctx.fillRect(0, H - 42, W, 4);
  // sidewalk
  ctx.fillStyle = '#7a7a82';
  ctx.fillRect(0, H - 50, W, 8);
  // street lines
  ctx.fillStyle = '#ffd76b';
  for (let x = 0; x < W; x += 40) ctx.fillRect(x, H - 22, 24, 3);
}

function drawFloor(body, def, type) {
  ctx.save();
  ctx.translate(body.position.x, body.position.y);
  ctx.rotate(body.angle);
  const w = def.w, h = def.h;

  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(-w/2 + 3, -h/2 + 3, w, h);

  // body
  ctx.fillStyle = def.color;
  ctx.fillRect(-w/2, -h/2, w, h);

  // top trim
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.fillRect(-w/2, -h/2, w, 3);
  // bottom shadow
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.fillRect(-w/2, h/2 - 3, w, 3);

  // windows / details
  ctx.fillStyle = '#ffd76b';
  if (def.windows === 'grid') {
    const cols = Math.floor(w / 18);
    const startX = -w/2 + (w - cols*14 - (cols-1)*4) / 2;
    for (let c = 0; c < cols; c++) {
      ctx.fillRect(startX + c*18, -6, 14, 12);
    }
  } else if (def.windows === 'strip') {
    ctx.fillRect(-w/2 + 8, -4, w - 16, 8);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    for (let x = -w/2 + 8; x < w/2 - 8; x += 12) ctx.fillRect(x, -4, 2, 8);
  } else if (def.windows === 'tall') {
    const cols = Math.floor(w / 22);
    const startX = -w/2 + (w - cols*16 - (cols-1)*6) / 2;
    for (let c = 0; c < cols; c++) {
      ctx.fillRect(startX + c*22, -h/2 + 6, 16, h - 12);
    }
    // crown
    ctx.fillStyle = '#fff3c0';
    ctx.fillRect(-w/2, -h/2 - 4, w, 4);
  } else if (def.windows === 'door') {
    // glass entrance
    ctx.fillRect(-30, -h/2 + 6, 60, h - 8);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(-1, -h/2 + 6, 2, h - 8);
    // side windows
    ctx.fillStyle = '#ffd76b';
    ctx.fillRect(-w/2 + 10, -6, 30, 12);
    ctx.fillRect(w/2 - 40, -6, 30, 12);
    // sign
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('LOBBY', 0, -h/2 - 2);
  } else if (def.windows === 'vent') {
    // mechanical vents
    ctx.fillStyle = '#2a2f3a';
    for (let x = -w/2 + 10; x < w/2 - 10; x += 16) {
      ctx.fillRect(x, -h/2 + 4, 10, h - 8);
    }
    ctx.fillStyle = '#8a9aaa';
    for (let x = -w/2 + 10; x < w/2 - 10; x += 16) {
      ctx.beginPath();
      ctx.arc(x + 5, 0, 3, 0, Math.PI*2);
      ctx.fill();
    }
  }

  ctx.restore();
}

function drawWindIndicator() {
  if (windActive <= 0 || Math.abs(wind) < 0.1) return;
  ctx.save();
  ctx.globalAlpha = 0.6;
  ctx.strokeStyle = '#9ef';
  ctx.lineWidth = 2;
  const dir = wind > 0 ? 1 : -1;
  for (let i = 0; i < 8; i++) {
    const y = 80 + i * 40 + Math.sin(performance.now()/200 + i) * 8;
    const len = 30 + Math.abs(wind) * 30;
    const startX = dir > 0 ? 20 : W - 20;
    ctx.beginPath();
    ctx.moveTo(startX, y);
    ctx.lineTo(startX + dir * len, y);
    ctx.stroke();
    // arrowhead
    ctx.beginPath();
    ctx.moveTo(startX + dir*len, y);
    ctx.lineTo(startX + dir*(len-6), y-4);
    ctx.moveTo(startX + dir*len, y);
    ctx.lineTo(startX + dir*(len-6), y+4);
    ctx.stroke();
  }
  ctx.restore();
}

function drawQuakeFlash() {
  if (quakeTimer <= 0) return;
  ctx.fillStyle = `rgba(255, 80, 40, ${quakeTimer * 0.25})`;
  ctx.fillRect(0, 0, W, H);
}

function drawDropGuide() {
  if (!fallingFloor) return;
  const x = fallingFloor.body.position.x;
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 215, 107, 0.4)';
  ctx.setLineDash([6, 6]);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, fallingFloor.body.position.y + 20);
  ctx.lineTo(x, H - 50);
  ctx.stroke();
  ctx.restore();
}

function render() {
  // Sky stays fixed (parallax-free for now)
  drawSky();

  // Camera offset + shake for the world layer
  const sx = shake > 0 ? (Math.random() - 0.5) * shake * 18 : 0;
  const sy = shake > 0 ? (Math.random() - 0.5) * shake * 18 : 0;

  ctx.save();
  ctx.translate(sx, -cameraY + sy);

  drawGround();
  drawDropGuide();
  for (const f of placedFloors) drawFloor(f.body, f.def, f.type);
  for (const f of droppingFloors) drawFloor(f.body, f.def, f.type);
  if (fallingFloor) drawFloor(fallingFloor.body, fallingFloor.def, fallingFloor.type);

  ctx.restore();

  // Screen-fixed overlays
  drawWindIndicator();
  drawQuakeFlash();
  drawToast();
  drawComboBadge();
  drawHeightMarker();
}

function drawComboBadge() {
  if (combo < 2) return;
  ctx.save();
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillStyle = '#9ef';
  ctx.fillText(`COMBO x${combo}`, W - 14, 24);
  ctx.restore();
}

function drawHeightMarker() {
  if (placedFloors.length < 1) return;
  ctx.save();
  ctx.font = 'bold 11px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.textAlign = 'left';
  ctx.fillText(`Height: ${placedFloors.length} floors`, 14, 24);
  ctx.restore();
}

function drawToast() {
  if (!toast) return;
  const a = Math.min(1, toast.t / 0.4);
  ctx.save();
  ctx.globalAlpha = a;
  ctx.font = 'bold 28px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillText(toast.text, W/2 + 2, H/2 - 80 + 2);
  ctx.fillStyle = toast.color;
  ctx.fillText(toast.text, W/2, H/2 - 80);
  ctx.restore();
}

// ---------- Main loop ----------
function loop(t) {
  if (!running) return;
  const dt = Math.min(0.05, (t - lastTime) / 1000 || 0.016);
  lastTime = t;

  // Smooth, capped descent + smooth horizontal aim for the falling floor
  if (fallingFloor && !fallingFloor.dropped) {
    const b = fallingFloor.body;
    // ease toward targetX (set by mousemove / nudge)
    const tx = fallingFloor.targetX;
    const nx = b.position.x + (tx - b.position.x) * Math.min(1, dt * 14);
    // gentle constant downward drift
    const ny = b.position.y + fallingFloor.fallSpeed * dt * 60;
    Body.setPosition(b, { x: nx, y: ny });
    Body.setVelocity(b, { x: 0, y: 0 });
  }

  Engine.update(engine, dt * 1000);
  updateForces(dt);

  // rent
  cash += rentPerSec * dt;

  // toast / camera / shake
  if (toast) { toast.t -= dt; if (toast.t <= 0) toast = null; }
  cameraY += (cameraTargetY - cameraY) * Math.min(1, dt * 3);
  if (shake > 0) shake = Math.max(0, shake - dt);

  // tilt
  tiltDeg = computeTilt();

  // win / lose
  const dist = DISTRICTS[districtIdx];
  if (cash >= dist.target) {
    if (districtIdx < DISTRICTS.length - 1) {
      districtIdx++;
      showOverlay('District Cleared!',
        `Welcome to ${DISTRICTS[districtIdx].name}. New target: ${fmt(DISTRICTS[districtIdx].target)}.`,
        'Continue');
    } else {
      showOverlay('Tycoon!', `You built a ${placedFloors.length}-floor empire across all districts.`, 'Play Again', true);
    }
    return;
  }
  if (cash < -10000) {
    showOverlay('Bankrupt', `Build costs outpaced rent. Floors built: ${placedFloors.length}.`, 'Try Again', true);
    return;
  }
  if (Math.abs(tiltDeg) > 25 && placedFloors.length > 2) {
    showOverlay('Tower Toppled!', `Tilt exceeded 25°. ${toppledFloors} floors lost.`, 'Try Again', true);
    return;
  }

  updateHUD();
  render();
  requestAnimationFrame(loop);
}

// ---------- Overlay ----------
function showOverlay(title, text, btn, restart) {
  running = false;
  $('overTitle').textContent = title;
  $('overText').textContent = text;
  $('startBtn').textContent = btn;
  $('overlay').classList.remove('hidden');
  $('startBtn').onclick = () => {
    if (restart) {
      districtIdx = 0;
      startGame();
    } else {
      // continue to next district — keep cash overflow
      const overflow = cash - DISTRICTS[districtIdx-1].target;
      startGame();
      cash = 50000 + Math.max(0, overflow);
    }
  };
}

function startGame() {
  $('overlay').classList.add('hidden');
  initEngine();
  buildStars();
  spawnFalling('lobby');
  running = true;
  lastTime = performance.now();
  requestAnimationFrame(loop);
}

// ---------- Input ----------
window.addEventListener('keydown', e => {
  const tutOpen = !$('tutorial').classList.contains('hidden');
  if (tutOpen) {
    if (e.code === 'ArrowRight' || e.code === 'Enter' || e.code === 'Space') { e.preventDefault(); $('tutNext').click(); }
    else if (e.code === 'ArrowLeft') { e.preventDefault(); $('tutPrev').click(); }
    else if (e.code === 'Escape') { e.preventDefault(); $('tutSkip').click(); }
    return;
  }
  if (!running) {
    if (e.code === 'Space' || e.code === 'Enter') {
      e.preventDefault();
      $('startBtn').click();
    }
    return;
  }
  if (e.code === 'Space') { e.preventDefault(); dropFalling(); }
  else if (e.code === 'Tab') { e.preventDefault(); cycleType(); }
  else if (e.code === 'ArrowLeft') { nudge(-1); }
  else if (e.code === 'ArrowRight') { nudge(1); }
});

canvas.addEventListener('click', e => {
  if (running) dropFalling();
});
canvas.addEventListener('mousemove', e => {
  if (!running || !fallingFloor || fallingFloor.dropped) return;
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (W / rect.width);
  const margin = fallingFloor.def.w/2 + 10;
  fallingFloor.targetX = Math.max(margin, Math.min(W - margin, x));
});

$('dropBtn').addEventListener('click', () => running && dropFalling());
$('skipBtn').addEventListener('click', () => running && cycleType());
$('startBtn').addEventListener('click', startGame);
$('helpBtn').addEventListener('click', () => { running = false; openTutorial(); });
$('tutorialBtn').addEventListener('click', openTutorial);

// ---------- Tutorial ----------
const TUTORIAL = [
  {
    title: 'Welcome, Developer',
    body: () => `
      <p>You're a real-estate developer building the next great skyline.</p>
      <p>Each round you start with <b>$50,000</b> seed cash and a target to hit. Build floors, collect rent, and grow your tower &mdash; without letting it fall over.</p>
      <p>Let's walk through the rules. Takes 30 seconds.</p>`
  },
  {
    title: 'The Goal',
    body: () => {
      const d = DISTRICTS[0];
      return `
      <p>Hit the cash <b>target</b> shown in the HUD. Your first district is <b>${d.name}</b>: target <b>${fmt(d.target)}</b>.</p>
      <p>Beat it &rarr; advance to the next district (Downtown, Coastal, Fault Line). Each one is harder.</p>
      <p>Cash comes from two places: <b>rent</b> ticking in every second from placed floors, and you <b>spend</b> cash to buy each new floor.</p>`;
    }
  },
  {
    title: 'Floor Types',
    body: () => `
      <p>You don't pick floors &mdash; the game deals them. The HUD shows what's <b>Next</b> and what it costs.</p>
      <div class="floor-grid">
        ${Object.entries(FLOORS).map(([k,f]) => `
          <div class="floor-row">
            <div class="swatch" style="background:${f.color}"></div>
            <div><b>${f.name}</b><br>${f.rent ? '$'+f.rent+'/s rent' : 'no rent'}</div>
            <span>${fmt(f.cost)}</span>
          </div>`).join('')}
      </div>
      <p style="margin-top:10px"><b>Lobby</b> is always your first floor. <b>Penthouse</b> only appears once you're 8 floors high. <b>Mechanical</b> earns nothing but is light and stable.</p>`
  },
  {
    title: 'Controls',
    body: () => `
      <p>A floor falls slowly from the top. While it falls:</p>
      <p>&bull; Move your <b>mouse</b> to aim it left/right<br>
         &bull; Press <span class="pill">SPACE</span> or <b>click</b> to drop it fast<br>
         &bull; Use <span class="pill">&larr;</span> <span class="pill">&rarr;</span> to nudge in the air<br>
         &bull; Press <span class="pill">TAB</span> to swap for a different random floor (costs <b>$500</b>)</p>
      <p>Aim for a clean overlap with the floor below &mdash; misalignment means overhang and tilt.</p>`
  },
  {
    title: 'Tilt &amp; Collapse',
    body: () => `
      <p>Watch the <b>Tilt</b> reading in the HUD. It measures how far your tower's top has drifted from its base.</p>
      <p>&bull; <b>Under 10&deg;</b> &mdash; safe<br>
         &bull; <b>10&ndash;25&deg;</b> &mdash; danger zone, every gust matters<br>
         &bull; <b>Over 25&deg;</b> &mdash; <b style="color:#f86">tower topples, run over</b></p>
      <p>Floors that tip past the edge slide off and are <b>lost</b> &mdash; their rent goes with them.</p>`
  },
  {
    title: 'Wind &amp; Earthquakes',
    body: () => `
      <p>Two hazards push your tower around:</p>
      <p>&bull; <b>Wind</b> only pushes <b>airborne</b> floors &mdash; the one you're aiming and any still falling toward the stack. Strong gusts can shove a floor right off your tower. Already-placed floors stand firm against wind.</p>
      <p>&bull; <b>Earthquakes</b> shake only the <b>placed</b> tower (red flash). Mid-air floors are unaffected. Rare in Suburb, common on the Fault Line.</p>
      <p>A wide base, careful alignment, and light <b>Mechanical</b> floors near the top help you survive.</p>`
  },
  {
    title: 'Lose Conditions',
    body: () => `
      <p>You lose the run if:</p>
      <p>&bull; <b>Tilt &gt; 25&deg;</b> &mdash; tower topples<br>
         &bull; <b>Cash &lt; -$10,000</b> &mdash; bankrupt (rent didn't keep up with build costs)</p>
      <p>You win the game by clearing all 4 districts. Ready?</p>`
  },
];

let tutIdx = 0;
function openTutorial() {
  tutIdx = 0;
  $('overlay').classList.add('hidden');
  $('tutorial').classList.remove('hidden');
  $('tutTotal').textContent = TUTORIAL.length;
  renderTutorial();
}
function renderTutorial() {
  const step = TUTORIAL[tutIdx];
  $('tutStep').textContent = tutIdx + 1;
  $('tutTitle').textContent = step.title;
  $('tutBody').innerHTML = step.body();
  $('tutPrev').style.visibility = tutIdx === 0 ? 'hidden' : 'visible';
  $('tutNext').textContent = tutIdx === TUTORIAL.length - 1 ? 'Start Build' : 'Next';
}
function closeTutorial(start) {
  $('tutorial').classList.add('hidden');
  if (start) startGame();
  else $('overlay').classList.remove('hidden');
}
$('tutNext').addEventListener('click', () => {
  if (tutIdx < TUTORIAL.length - 1) { tutIdx++; renderTutorial(); }
  else closeTutorial(true);
});
$('tutPrev').addEventListener('click', () => {
  if (tutIdx > 0) { tutIdx--; renderTutorial(); }
});
$('tutSkip').addEventListener('click', () => closeTutorial(false));

// initial render of overlay
buildStars();
drawSky();
drawGround();

// First-visit auto-tutorial
if (!localStorage.getItem('skyline_tutorial_seen')) {
  localStorage.setItem('skyline_tutorial_seen', '1');
  $('overlay').classList.add('hidden');
  openTutorial();
}
