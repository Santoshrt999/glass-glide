// game.ts — game state, physics, difficulty, collisions. No rendering, no DOM.
//
// All physics run in a virtual world that is always WORLD_H units tall;
// the renderer scales it to the screen, so the feel is identical on every
// device. Update uses delta time (clamped) so speed is framerate-independent.

export const WORLD_H = 720;

export const TUNING = {
  gravity: 1800, // px/s^2
  flapImpulse: -520, // px/s
  maxFallSpeed: 980, // px/s terminal velocity
  orbRadius: 17,

  // Dynamic difficulty: each value eases (smoothstep) from *Start to *End
  // over the first `rampPillars` pillars.
  speedStart: 175, // pillar scroll px/s
  speedEnd: 335,
  gapStart: 252, // gap height
  gapEnd: 150,
  spacingStart: 345, // horizontal distance between pillars
  spacingEnd: 258,
  rampPillars: 30,
  pillarWidth: 84,

  lensEvery: 8, // a lens spawns roughly every N pillars
  shieldEvery: 14, // shields are rarer
  pickupRadius: 26,
  lensDuration: 4, // seconds of slow-mo (real time)
  lensTimeScale: 0.5,

  driftFromPillar: 18, // pillars may drift vertically after this many
  driftChance: 0.45,
  driftAmpMax: 64,

  grazeBand: 9, // px of clearance that still counts as a near-miss

  trailSeconds: 2, // ghost replay length
};

export type Phase = 'ready' | 'playing' | 'paused' | 'dead';

export interface Pillar {
  x: number;
  w: number;
  gapY: number;
  gapH: number;
  scored: boolean;
  grazed: boolean; // came within grazeBand of a column — near-miss on score
  pulse: number; // rim-light pulse, 1 -> 0 after being scored
  baseGapY: number;
  driftAmp: number; // 0 = static pillar
  driftSpeed: number;
  driftPhase: number;
}

export type PickupKind = 'lens' | 'shield';

export interface Pickup {
  x: number;
  y: number;
  r: number;
  taken: boolean;
  kind: PickupKind;
}

/** Bobbing y shared by render and collision so the hitbox matches the visual. */
export function pickupBobY(p: Pickup, time: number): number {
  return p.y + Math.sin(time * 2.6 + p.x * 0.01) * 7;
}

export interface GhostSample {
  t: number;
  x: number;
  y: number;
}

export interface GameHooks {
  onFlap(): void;
  onScore(score: number): void;
  onNearMiss(): void;
  onLens(): void;
  onShield(): void;
  onShieldPop(): void;
  onDeath(score: number, best: number, newBest: boolean): void;
}

const BEST_KEY = 'glassglide.best';

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export class Game {
  phase: Phase = 'ready';
  worldW = 400;
  readonly worldH = WORLD_H;

  orbX = 130;
  orbY = WORLD_H / 2;
  vy = 0;

  pillars: Pillar[] = [];
  pickups: Pickup[] = [];
  trail: GhostSample[] = [];
  ghost: GhostSample[] = [];

  score = 0;
  best = Number(localStorage.getItem(BEST_KEY) ?? 0) || 0;
  spawnedCount = 0;
  scrollX = 0;
  time = 0; // world time (slows during lens mode)
  realTime = 0; // wall-clock play time (trail/ghost timestamps)
  lensTimeLeft = 0;
  shielded = false;
  invulnFor = 0; // grace period after a shield pop, real seconds
  shake = 0; // 1 -> 0 after death
  flash = 0; // chromatic flash, 1 -> 0 after death
  deadFor = 0; // real seconds since death (drives ghost replay)

  private distToNextSpawn = 0;
  private idleT = 0;

  constructor(private hooks: GameHooks) {}

  setSize(w: number): void {
    this.worldW = w;
    this.orbX = Math.max(110, Math.min(w * 0.3, 240));
  }

  /** 0 (friendly) -> 1 (brutal), eased over the first rampPillars pillars. */
  get difficulty(): number {
    const t = Math.min(this.spawnedCount / TUNING.rampPillars, 1);
    return t * t * (3 - 2 * t);
  }

  get speed(): number {
    return lerp(TUNING.speedStart, TUNING.speedEnd, this.difficulty);
  }

  start(): void {
    this.pillars = [];
    this.pickups = [];
    this.trail = [];
    this.ghost = [];
    this.score = 0;
    this.spawnedCount = 0;
    this.scrollX = 0;
    this.time = 0;
    this.realTime = 0;
    this.lensTimeLeft = 0;
    this.shielded = false;
    this.invulnFor = 0;
    this.shake = 0;
    this.flash = 0;
    this.deadFor = 0;
    this.orbY = this.worldH * 0.45;
    this.vy = TUNING.flapImpulse; // opening hop
    this.distToNextSpawn = 90;
    this.phase = 'playing';
  }

  flapInput(): void {
    if (this.phase !== 'playing') return;
    this.vy = TUNING.flapImpulse;
    this.hooks.onFlap();
  }

  update(dtRaw: number): void {
    const dtReal = Math.min(dtRaw, 1 / 30);

    // Effect timers decay in real time so slow-mo doesn't stretch them.
    this.shake = Math.max(0, this.shake - dtReal * 2.2);
    this.flash = Math.max(0, this.flash - dtReal * 3);
    this.invulnFor = Math.max(0, this.invulnFor - dtReal);
    for (const p of this.pillars) p.pulse = Math.max(0, p.pulse - dtReal * 2.5);

    if (this.phase === 'ready') {
      this.idleT += dtReal;
      this.orbY = this.worldH * 0.5 + Math.sin(this.idleT * 2.2) * 14;
      return;
    }
    if (this.phase === 'paused') return;
    if (this.phase === 'dead') {
      this.deadFor += dtReal;
      return;
    }

    // Lens slow-mo: world time runs at half speed, the 4s budget in real time.
    const slow = this.lensTimeLeft > 0;
    this.lensTimeLeft = Math.max(0, this.lensTimeLeft - dtReal);
    const dt = dtReal * (slow ? TUNING.lensTimeScale : 1);
    this.time += dt;
    this.realTime += dtReal;

    // Orb physics
    this.vy = Math.min(this.vy + TUNING.gravity * dt, TUNING.maxFallSpeed);
    this.orbY += this.vy * dt;
    const r = TUNING.orbRadius;
    if (this.orbY < r) {
      this.orbY = r;
      this.vy = 0;
    }
    if (this.orbY > this.worldH - r) {
      this.orbY = this.worldH - r;
      if (this.shielded) {
        this.vy = TUNING.flapImpulse; // shield bounces you off the floor
        this.popShield();
      } else {
        this.die();
        return;
      }
    }

    // Scroll the world
    const dx = this.speed * dt;
    this.scrollX += dx;
    for (const p of this.pillars) p.x -= dx;
    for (const k of this.pickups) k.x -= dx;
    this.pillars = this.pillars.filter((p) => p.x + p.w > -40);
    this.pickups = this.pickups.filter((k) => !k.taken && k.x > -60);

    // Drifting pillars (world time, so lens slow-mo slows them too)
    for (const p of this.pillars) {
      if (p.driftAmp > 0) {
        p.gapY = p.baseGapY + Math.sin(this.time * p.driftSpeed + p.driftPhase) * p.driftAmp;
      }
    }

    this.distToNextSpawn -= dx;
    if (this.distToNextSpawn <= 0) this.spawn();

    // Near-miss tracking: inside the graze band but not actually colliding.
    for (const p of this.pillars) {
      if (
        !p.scored &&
        !p.grazed &&
        this.overlapsPillar(p, r + TUNING.grazeBand) &&
        !this.overlapsPillar(p, r - 2.5)
      ) {
        p.grazed = true;
      }
    }

    // Scoring
    for (const p of this.pillars) {
      if (!p.scored && p.x + p.w < this.orbX - r) {
        p.scored = true;
        p.pulse = 1;
        this.score++;
        this.hooks.onScore(this.score);
        if (p.grazed) this.hooks.onNearMiss();
      }
    }

    // Pickups (collision uses the same bob as the renderer)
    for (const k of this.pickups) {
      const ky = pickupBobY(k, this.time);
      const dxl = k.x - this.orbX;
      const dyl = ky - this.orbY;
      const rr = k.r + r;
      if (dxl * dxl + dyl * dyl < rr * rr) {
        k.taken = true;
        if (k.kind === 'lens') {
          this.lensTimeLeft = TUNING.lensDuration;
          this.hooks.onLens();
        } else {
          this.shielded = true;
          this.hooks.onShield();
        }
      }
    }

    // Pillar collision
    if (this.invulnFor <= 0) {
      for (const p of this.pillars) {
        if (this.overlapsPillar(p, r - 2.5)) {
          if (this.shielded) {
            this.popShield();
            break;
          }
          this.die();
          return;
        }
      }
    }

    // Ghost trail recording. Real-time timestamps so the death replay plays
    // back at the pace the player actually saw (slow-mo stays slow).
    this.trail.push({ t: this.realTime, x: this.orbX, y: this.orbY });
    const cutoff = this.realTime - TUNING.trailSeconds;
    while (this.trail.length > 0 && this.trail[0].t < cutoff) this.trail.shift();
  }

  togglePause(): void {
    if (this.phase === 'playing') this.phase = 'paused';
    else if (this.phase === 'paused') this.phase = 'playing';
  }

  private overlapsPillar(p: Pillar, r: number): boolean {
    return (
      circleRect(this.orbX, this.orbY, r, p.x, -40, p.w, p.gapY + 40) ||
      circleRect(this.orbX, this.orbY, r, p.x, p.gapY + p.gapH, p.w, this.worldH)
    );
  }

  private popShield(): void {
    this.shielded = false;
    this.invulnFor = 1.0; // grace to clear the pillar you just hit
    this.hooks.onShieldPop();
  }

  private spawn(): void {
    const e = this.difficulty;
    const gapH = lerp(TUNING.gapStart, TUNING.gapEnd, e);
    const margin = 70;
    const gapY = margin + Math.random() * (this.worldH - gapH - margin * 2);
    const x = this.worldW + 40;

    let driftAmp = 0;
    let driftSpeed = 0;
    let driftPhase = 0;
    if (this.spawnedCount >= TUNING.driftFromPillar && Math.random() < TUNING.driftChance) {
      // Clamp amplitude so the gap can never leave the playfield.
      const room = Math.min(gapY - margin, this.worldH - margin - gapH - gapY);
      driftAmp = Math.min(TUNING.driftAmpMax, room);
      if (driftAmp > 12) {
        driftSpeed = 0.7 + Math.random() * 0.5;
        driftPhase = Math.random() * Math.PI * 2;
      } else {
        driftAmp = 0;
      }
    }

    this.pillars.push({
      x,
      w: TUNING.pillarWidth,
      gapY,
      gapH,
      scored: false,
      grazed: false,
      pulse: 0,
      baseGapY: gapY,
      driftAmp,
      driftSpeed,
      driftPhase,
    });
    this.spawnedCount++;
    const spacing = lerp(TUNING.spacingStart, TUNING.spacingEnd, e);
    this.distToNextSpawn = spacing;

    const kind: PickupKind | null =
      this.spawnedCount % TUNING.lensEvery === 3
        ? 'lens'
        : this.spawnedCount % TUNING.shieldEvery === 9
          ? 'shield'
          : null;
    if (kind) {
      this.pickups.push({
        x: x + spacing * 0.55,
        y: 130 + Math.random() * (this.worldH - 260),
        r: TUNING.pickupRadius,
        taken: false,
        kind,
      });
    }
  }

  private die(): void {
    this.phase = 'dead';
    this.deadFor = 0;
    this.shake = 1;
    this.flash = 1;
    this.lensTimeLeft = 0;
    this.ghost = this.trail.slice();
    const newBest = this.score > this.best;
    if (newBest) {
      this.best = this.score;
      localStorage.setItem(BEST_KEY, String(this.best));
    }
    this.hooks.onDeath(this.score, this.best, newBest);
  }
}

function circleRect(
  cx: number,
  cy: number,
  r: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
): boolean {
  const nx = Math.max(rx, Math.min(cx, rx + rw));
  const ny = Math.max(ry, Math.min(cy, ry + rh));
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}
