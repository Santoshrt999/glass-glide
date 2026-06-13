// render.ts — all canvas drawing: blobs, pillars, orb, trail, ghost, particles.
//
// GLASS APPROACH (the performance call):
// Everything game-world lives on a single canvas. Real CSS backdrop-filter
// pillars were rejected: each moving pillar would be its own compositing
// layer re-running a backdrop blur every frame — the single most expensive
// thing you can ask a mobile GPU to do — and 3–5 pillars plus UI panels
// blows past any sane blur budget. Instead, the blob background is rendered
// to a small offscreen canvas (~1/5 resolution); each pillar samples that
// offscreen, slightly MAGNIFIED, through a rounded-rect clip. Upscaling the
// low-res sample gives free blur (bilinear smoothing) and the magnification
// reads as refraction — a convincing glass fake at a fraction of the cost.
// Real backdrop-filter blur(22px) is reserved for the static DOM UI panels,
// of which at most 4 are ever visible at once.

import type { Game, Pickup, Pillar } from './game';
import { pickupBobY, TUNING, WORLD_H } from './game';

const TAU = Math.PI * 2;

type Rgb = [number, number, number];

// Day cycle palettes: dusk -> neon night -> dawn, cross-faded every 10 points.
const PALETTES: string[][] = [
  ['#0fb9a9', '#7c5cff', '#ff8a3d', '#2bd4ff'], // dusk: teal, violet, orange, cyan
  ['#19e3ff', '#c44dff', '#ff4d8d', '#4dffb8'], // neon night
  ['#ffd166', '#ff7b9c', '#ffae5e', '#7bd4ff'], // dawn
];

// Parallax blobs: `depth` is the fraction of pillar scroll speed each blob
// moves at — far blobs (small depth) drift slower, so depth reads clearly.
const BLOBS = [
  { fx: 0.18, fy: 0.3, r: 0.62, depth: 0.04, sp: 0.05, ph: 0.0 },
  { fx: 0.62, fy: 0.7, r: 0.75, depth: 0.025, sp: 0.04, ph: 2.1 },
  { fx: 0.85, fy: 0.25, r: 0.55, depth: 0.06, sp: 0.06, ph: 4.0 },
  { fx: 0.4, fy: 0.85, r: 0.5, depth: 0.085, sp: 0.07, ph: 1.2 },
];

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  grav: number;
  col: string;
}

interface Shard {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  life: number;
  max: number;
  verts: [number, number][];
}

interface Crack {
  x: number;
  y: number;
  life: number;
  max: number;
  lines: [number, number][][];
}

interface Ring {
  x: number;
  y: number;
  r: number;
  life: number;
  max: number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function hexToRgb(h: string): Rgb {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private bg = document.createElement('canvas');
  private bgCtx: CanvasRenderingContext2D;
  private worldW = 400;
  private s = 1; // device px per world unit
  private bgScale = 1; // bg-canvas px per world unit
  private t = 0;
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private particles: Particle[] = [];
  private shards: Shard[] = [];
  private cracks: Crack[] = [];
  private rings: Ring[] = [];
  private palIndex = 0;
  private colsFrom: Rgb[];
  private colsTo: Rgb[];
  private blend = 1;
  private lensOn = false;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    const bgCtx = this.bg.getContext('2d');
    if (!ctx || !bgCtx) throw new Error('2d canvas unsupported');
    this.ctx = ctx;
    this.bgCtx = bgCtx;
    this.colsFrom = PALETTES[0].map(hexToRgb);
    this.colsTo = this.colsFrom;
  }

  /** Resizes backing stores; returns the new world width in world units. */
  resize(): number {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.canvas.clientWidth * dpr);
    this.canvas.height = Math.round(this.canvas.clientHeight * dpr);
    this.s = this.canvas.height / WORLD_H;
    this.worldW = this.canvas.width / this.s;
    const bgH = 144;
    this.bg.height = bgH;
    this.bg.width = Math.max(1, Math.round(this.worldW * (bgH / WORLD_H)));
    this.bgScale = bgH / WORLD_H;
    return this.worldW;
  }

  nextPalette(): void {
    this.goToPalette((this.palIndex + 1) % PALETTES.length);
  }

  resetPalette(): void {
    if (this.palIndex !== 0) this.goToPalette(0);
  }

  private goToPalette(i: number): void {
    this.colsFrom = this.currentCols();
    this.colsTo = PALETTES[i].map(hexToRgb);
    this.palIndex = i;
    this.blend = 0;
  }

  private currentCols(): Rgb[] {
    const b = this.blend;
    return this.colsTo.map((c, i) => {
      const f = this.colsFrom[i];
      return [lerp(f[0], c[0], b), lerp(f[1], c[1], b), lerp(f[2], c[2], b)] as Rgb;
    });
  }

  burst(x: number, y: number, kind: 'flap' | 'shatter' | 'spark'): void {
    if (kind === 'flap') {
      for (let i = 0; i < 9; i++) {
        const ang = Math.PI / 2 + (Math.random() - 0.5) * 1.4; // downward cone
        const sp = 60 + Math.random() * 140;
        this.particles.push({
          x: x - 6,
          y: y + 8,
          vx: Math.cos(ang) * sp - 40,
          vy: Math.sin(ang) * sp,
          life: 0.45 + Math.random() * 0.2,
          max: 0.65,
          size: 1.5 + Math.random() * 2.5,
          grav: 240,
          col: 'rgb(200,235,255)',
        });
      }
    } else if (kind === 'spark') {
      for (let i = 0; i < 8; i++) {
        const ang = Math.random() * TAU;
        const sp = 40 + Math.random() * 130;
        this.particles.push({
          x,
          y,
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp,
          life: 0.3 + Math.random() * 0.2,
          max: 0.5,
          size: 1 + Math.random() * 1.6,
          grav: 60,
          col: 'rgb(255,235,180)',
        });
      }
    } else {
      // Glass-shard death: spinning polygon shards + dust + a crack flash.
      for (let i = 0; i < 16; i++) {
        const ang = Math.random() * TAU;
        const sp = 60 + Math.random() * 380;
        this.particles.push({
          x,
          y,
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp - 80,
          life: 0.55 + Math.random() * 0.55,
          max: 1.1,
          size: 1.5 + Math.random() * 4,
          grav: 760,
          col: 'rgb(200,235,255)',
        });
      }
      for (let i = 0; i < 12; i++) {
        const ang = Math.random() * TAU;
        const sp = 90 + Math.random() * 300;
        const nVerts = 3 + ((Math.random() * 2) | 0);
        const verts: [number, number][] = [];
        for (let j = 0; j < nVerts; j++) {
          const va = (j / nVerts) * TAU + Math.random() * 0.8;
          const vr = 3 + Math.random() * 6.5;
          verts.push([Math.cos(va) * vr, Math.sin(va) * vr]);
        }
        this.shards.push({
          x,
          y,
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp - 120,
          rot: Math.random() * TAU,
          vr: (Math.random() - 0.5) * 14,
          life: 0.7 + Math.random() * 0.5,
          max: 1.2,
          verts,
        });
      }
      const lines: [number, number][][] = [];
      for (let i = 0; i < 7; i++) {
        const ang = Math.random() * TAU;
        const pts: [number, number][] = [[0, 0]];
        let px = 0;
        let py = 0;
        let a = ang;
        for (let seg = 0; seg < 3; seg++) {
          a += (Math.random() - 0.5) * 0.9;
          const len = 10 + Math.random() * 18;
          px += Math.cos(a) * len;
          py += Math.sin(a) * len;
          pts.push([px, py]);
        }
        lines.push(pts);
      }
      this.cracks.push({ x, y, life: 0.45, max: 0.45, lines });
    }
    if (this.particles.length > 220) this.particles.splice(0, this.particles.length - 220);
  }

  /** Expanding ring, used for the shield pop. */
  ring(x: number, y: number): void {
    this.rings.push({ x, y, r: TUNING.orbRadius * 1.6, life: 0.5, max: 0.5 });
  }

  draw(game: Game, dtReal: number): void {
    this.t += dtReal;
    if (this.blend < 1) this.blend = Math.min(1, this.blend + dtReal / 1.4);
    this.updateEffects(dtReal, game.lensTimeLeft > 0);
    this.drawBg(game.scrollX);

    const c = this.ctx;
    c.setTransform(this.s, 0, 0, this.s, 0, 0);
    c.fillStyle = '#0B1020';
    c.fillRect(0, 0, this.worldW, WORLD_H); // covers edges exposed by shake

    if (game.shake > 0 && !this.reducedMotion) {
      const k = game.shake * game.shake * 14;
      c.translate((Math.random() * 2 - 1) * k, (Math.random() * 2 - 1) * k);
    }

    c.drawImage(this.bg, 0, 0, this.worldW, WORLD_H);

    for (const p of game.pillars) this.drawPillar(p);
    for (const k of game.pickups) this.drawPickup(k, game.time);

    if (game.phase === 'dead') {
      this.drawGhost(game);
    } else {
      this.drawTrail(game);
      // Post-shield-pop grace reads as a blink.
      const alpha = game.invulnFor > 0 ? 0.55 + 0.35 * Math.sin(this.t * 28) : 1;
      this.drawOrb(game.orbX, game.orbY, TUNING.orbRadius, alpha);
      if (game.shielded) this.drawShieldBubble(game.orbX, game.orbY);
    }

    this.drawEffects();
    this.drawLensOverlay(game);
  }

  private drawBg(scrollX: number): void {
    const g = this.bgCtx;
    const W = this.bg.width;
    const H = this.bg.height;
    const cols = this.currentCols();
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#0B1020';
    g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'lighter';
    const drift = this.reducedMotion ? 0 : 1;
    for (let i = 0; i < BLOBS.length; i++) {
      const b = BLOBS[i];
      const col = cols[i];
      const R = b.r * H;
      const range = W + R * 2;
      let cx = b.fx * W + Math.sin(this.t * b.sp + b.ph) * W * 0.08 * drift - scrollX * b.depth * this.bgScale;
      cx = (((cx + R) % range) + range) % range - R;
      const cy = b.fy * H + Math.cos(this.t * b.sp * 0.8 + b.ph) * H * 0.07 * drift;
      const grad = g.createRadialGradient(cx, cy, 0, cx, cy, R);
      grad.addColorStop(0, `rgba(${col[0] | 0},${col[1] | 0},${col[2] | 0},0.55)`);
      grad.addColorStop(1, `rgba(${col[0] | 0},${col[1] | 0},${col[2] | 0},0)`);
      g.fillStyle = grad;
      g.fillRect(cx - R, cy - R, R * 2, R * 2);
    }
    // Caustic shimmer: faint drifting light bands for an underwater feel.
    // Drawn into the bg sample, so it also refracts through the glass.
    if (drift) {
      for (let i = 0; i < 4; i++) {
        const yy = ((i + 0.5) / 4) * H + Math.sin(this.t * 0.55 + i * 2.1) * H * 0.16;
        const band = g.createLinearGradient(0, yy - 14, 0, yy + 14);
        band.addColorStop(0, 'rgba(150,210,255,0)');
        band.addColorStop(0.5, 'rgba(175,220,255,0.13)');
        band.addColorStop(1, 'rgba(150,210,255,0)');
        g.fillStyle = band;
        g.fillRect(0, yy - 14, W, 28);
      }
    }
    g.globalCompositeOperation = 'source-over';
  }

  /**
   * Draws a magnified background sample into a region the caller has clipped,
   * sliced into horizontal bands each shifted by an animated sine wave — a
   * cheap water-refraction shimmer. Bands are over-drawn horizontally so the
   * shift never exposes a gap at the clip edge. Falls back to a single static
   * draw under prefers-reduced-motion.
   */
  private wavyBg(dx: number, dy: number, dw: number, dh: number, mag: number, phase: number): void {
    const c = this.ctx;
    const bs = this.bgScale;
    const sw = (dw * bs) / mag;
    const sh = (dh * bs) / mag;
    const scx = (dx + dw / 2) * bs;
    const scy = (dy + dh / 2) * bs;
    if (this.reducedMotion) {
      c.drawImage(this.bg, scx - sw / 2, scy - sh / 2, sw, sh, dx, dy, dw, dh);
      return;
    }
    const bands = Math.min(28, Math.max(2, Math.ceil(dh / 26)));
    const bandH = dh / bands;
    const srcBandH = sh / bands;
    const srcTop = scy - sh / 2;
    const pad = 5;
    for (let i = 0; i < bands; i++) {
      const ddy = dy + i * bandH;
      const wob = Math.sin(this.t * 2 + (ddy + phase) * 0.02) * 4.5;
      c.drawImage(
        this.bg,
        scx - sw / 2,
        srcTop + i * srcBandH,
        sw,
        srcBandH,
        dx - pad + wob,
        ddy - 0.5,
        dw + pad * 2,
        bandH + 1,
      );
    }
  }

  private drawPillar(p: Pillar): void {
    const botY = p.gapY + p.gapH;
    const drifting = p.driftAmp > 0;
    this.glassColumn(p.x, -24, p.w, p.gapY + 24, [0, 0, 20, 20], p.pulse, 'down', drifting);
    this.glassColumn(p.x, botY, p.w, WORLD_H - botY + 24, [20, 20, 0, 0], p.pulse, 'up', drifting);
  }

  private glassColumn(
    x: number,
    y: number,
    w: number,
    h: number,
    radii: number[],
    pulse: number,
    capSide: 'up' | 'down',
    drifting: boolean,
  ): void {
    const c = this.ctx;
    c.save();
    c.beginPath();
    c.roundRect(x, y, w, h, radii);
    c.clip();

    // Refraction fake: magnified low-res background sample (see file header),
    // rippling like water (see wavyBg).
    this.wavyBg(x, y, w, h, 1.22, x);

    // Frost tint + edge sheen
    c.fillStyle = 'rgba(255,255,255,0.075)';
    c.fillRect(x, y, w, h);
    const sheen = c.createLinearGradient(x, 0, x + w, 0);
    sheen.addColorStop(0, 'rgba(255,255,255,0.16)');
    sheen.addColorStop(0.35, 'rgba(255,255,255,0)');
    sheen.addColorStop(0.85, 'rgba(255,255,255,0)');
    sheen.addColorStop(1, 'rgba(255,255,255,0.10)');
    c.fillStyle = sheen;
    c.fillRect(x, y, w, h);
    c.restore();

    // Rim light (pulses when the pillar is scored; cyan telegraphs a drifter)
    c.beginPath();
    c.roundRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5, radii);
    if (pulse > 0) {
      c.save();
      c.shadowColor = `rgba(170,225,255,${0.9 * pulse})`;
      c.shadowBlur = 26 * pulse;
      c.strokeStyle = `rgba(255,255,255,${0.3 + 0.65 * pulse})`;
      c.lineWidth = 1.6;
      c.stroke();
      c.restore();
    } else {
      c.strokeStyle = drifting ? 'rgba(140,230,255,0.55)' : 'rgba(255,255,255,0.3)';
      c.lineWidth = 1.5;
      c.stroke();
    }

    // Bright edge on the cap facing the gap — undulates like a liquid surface.
    const edgeY = capSide === 'down' ? y + h - 1.5 : y + 1.5;
    c.strokeStyle = drifting
      ? `rgba(160,235,255,${0.55 + 0.4 * pulse})`
      : `rgba(255,255,255,${0.4 + 0.5 * pulse})`;
    c.lineWidth = 2;
    c.beginPath();
    const amp = this.reducedMotion ? 0 : 2.1;
    const phase = capSide === 'down' ? 0 : 1.6;
    const x0 = x + 14;
    const x1 = x + w - 14;
    for (let px = x0; px <= x1; px += 4) {
      const ey = edgeY + Math.sin(this.t * 3.2 + px * 0.22 + phase) * amp;
      if (px === x0) c.moveTo(px, ey);
      else c.lineTo(px, ey);
    }
    c.stroke();
  }

  private drawPickup(k: Pickup, time: number): void {
    const c = this.ctx;
    const y = pickupBobY(k, time);
    if (k.kind === 'lens') {
      c.save();
      c.beginPath();
      c.arc(k.x, y, k.r, 0, TAU);
      c.clip();
      const d = k.r * 2;
      this.wavyBg(k.x - k.r, y - k.r, d, d, 1.7, k.x);
      c.fillStyle = 'rgba(255,255,255,0.10)';
      c.fill();
      c.restore();
      c.strokeStyle = 'rgba(255,255,255,0.85)';
      c.lineWidth = 1.6;
      c.beginPath();
      c.arc(k.x, y, k.r, 0, TAU);
      c.stroke();
      c.strokeStyle = 'rgba(160,220,255,0.35)';
      c.lineWidth = 3;
      c.beginPath();
      c.arc(k.x, y, k.r + 4, 0, TAU);
      c.stroke();
    } else {
      // Shield: a soap-bubble look, visually distinct from the refractive lens.
      const grad = c.createRadialGradient(k.x - k.r * 0.3, y - k.r * 0.35, k.r * 0.2, k.x, y, k.r);
      grad.addColorStop(0, 'rgba(200,240,255,0.35)');
      grad.addColorStop(0.8, 'rgba(140,200,255,0.08)');
      grad.addColorStop(1, 'rgba(160,220,255,0.30)');
      c.fillStyle = grad;
      c.beginPath();
      c.arc(k.x, y, k.r, 0, TAU);
      c.fill();
      c.strokeStyle = 'rgba(220,245,255,0.9)';
      c.lineWidth = 1.6;
      c.stroke();
      c.strokeStyle = 'rgba(180,230,255,0.5)';
      c.lineWidth = 1.2;
      c.beginPath();
      c.arc(k.x, y, k.r * 0.55, 0, TAU);
      c.stroke();
    }
    c.fillStyle = 'rgba(255,255,255,0.55)';
    c.beginPath();
    c.ellipse(k.x - k.r * 0.35, y - k.r * 0.38, k.r * 0.24, k.r * 0.14, -0.6, 0, TAU);
    c.fill();
  }

  private drawShieldBubble(x: number, y: number): void {
    const c = this.ctx;
    const r = TUNING.orbRadius * 1.85 + Math.sin(this.t * 4) * 1.5;
    const grad = c.createRadialGradient(x, y, r * 0.6, x, y, r);
    grad.addColorStop(0, 'rgba(170,220,255,0)');
    grad.addColorStop(1, 'rgba(170,220,255,0.14)');
    c.fillStyle = grad;
    c.beginPath();
    c.arc(x, y, r, 0, TAU);
    c.fill();
    c.strokeStyle = 'rgba(190,235,255,0.8)';
    c.lineWidth = 1.4;
    c.stroke();
    c.strokeStyle = 'rgba(255,255,255,0.55)';
    c.lineWidth = 2;
    c.beginPath();
    c.arc(x, y, r - 2, -2.2, -1.2);
    c.stroke();
  }

  private drawOrb(x: number, y: number, r: number, alpha: number): void {
    const c = this.ctx;
    c.save();
    c.globalAlpha = alpha;
    const halo = c.createRadialGradient(x, y, r * 0.5, x, y, r * 3.2);
    halo.addColorStop(0, 'rgba(150,215,255,0.35)');
    halo.addColorStop(1, 'rgba(150,215,255,0)');
    c.fillStyle = halo;
    c.beginPath();
    c.arc(x, y, r * 3.2, 0, TAU);
    c.fill();
    const body = c.createRadialGradient(x - r * 0.38, y - r * 0.42, r * 0.15, x, y, r);
    body.addColorStop(0, 'rgba(255,255,255,0.95)');
    body.addColorStop(0.45, 'rgba(200,235,255,0.45)');
    body.addColorStop(1, 'rgba(150,190,255,0.20)');
    c.fillStyle = body;
    c.beginPath();
    c.arc(x, y, r, 0, TAU);
    c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.75)';
    c.lineWidth = 1.3;
    c.stroke();
    c.fillStyle = 'rgba(255,255,255,0.9)';
    c.beginPath();
    c.ellipse(x - r * 0.35, y - r * 0.45, r * 0.22, r * 0.14, -0.6, 0, TAU);
    c.fill();
    c.restore();
  }

  private drawTrail(game: Game): void {
    const c = this.ctx;
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.fillStyle = 'rgb(160,215,255)';
    for (const s of game.trail) {
      const age = game.realTime - s.t;
      if (age > 0.55) continue;
      const k = 1 - age / 0.55;
      c.globalAlpha = k * 0.22;
      c.beginPath();
      c.arc(s.x, s.y, TUNING.orbRadius * (0.35 + 0.5 * k), 0, TAU);
      c.fill();
    }
    c.restore();
  }

  /** Looping translucent replay of the last 2s, shown behind the game-over card. */
  private drawGhost(game: Game): void {
    const gh = game.ghost;
    if (gh.length < 2) return;
    const t0 = gh[0].t;
    const t1 = gh[gh.length - 1].t;
    const dur = t1 - t0;
    if (dur < 0.25) return;
    const tt = t0 + (game.deadFor % dur);
    let i = 1;
    while (i < gh.length - 1 && gh[i].t < tt) i++;
    const a = gh[i - 1];
    const b = gh[i];
    const f = (tt - a.t) / Math.max(1e-4, b.t - a.t);
    const x = lerp(a.x, b.x, f);
    const y = lerp(a.y, b.y, f);
    const fade = Math.min(1, (tt - t0) / 0.25, (t1 - tt) / 0.25); // hide the loop seam

    const c = this.ctx;
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.fillStyle = 'rgb(160,215,255)';
    for (let j = i - 1; j >= 0; j--) {
      const age = tt - gh[j].t;
      if (age > 0.5) break;
      const k = 1 - age / 0.5;
      c.globalAlpha = k * 0.1 * fade;
      c.beginPath();
      c.arc(gh[j].x, gh[j].y, TUNING.orbRadius * 0.6 * k, 0, TAU);
      c.fill();
    }
    c.restore();
    this.drawOrb(x, y, TUNING.orbRadius, 0.35 * fade);
  }

  private updateEffects(dtReal: number, slow: boolean): void {
    const dt = dtReal * (slow ? TUNING.lensTimeScale : 1);
    for (const p of this.particles) {
      p.life -= dt;
      p.vy += p.grav * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    // Death effects always run in real time (the world is frozen by then).
    for (const sh of this.shards) {
      sh.life -= dtReal;
      sh.vy += 900 * dtReal;
      sh.x += sh.vx * dtReal;
      sh.y += sh.vy * dtReal;
      sh.rot += sh.vr * dtReal;
    }
    this.shards = this.shards.filter((sh) => sh.life > 0);
    for (const cr of this.cracks) cr.life -= dtReal;
    this.cracks = this.cracks.filter((cr) => cr.life > 0);
    for (const rg of this.rings) {
      rg.life -= dtReal;
      rg.r += 260 * dtReal;
    }
    this.rings = this.rings.filter((rg) => rg.life > 0);
  }

  private drawEffects(): void {
    const c = this.ctx;
    if (this.particles.length > 0) {
      c.save();
      c.globalCompositeOperation = 'lighter';
      for (const p of this.particles) {
        c.globalAlpha = (p.life / p.max) * 0.85;
        c.fillStyle = p.col;
        c.beginPath();
        c.arc(p.x, p.y, p.size, 0, TAU);
        c.fill();
      }
      c.restore();
    }
    for (const sh of this.shards) {
      c.save();
      c.translate(sh.x, sh.y);
      c.rotate(sh.rot);
      c.globalAlpha = (sh.life / sh.max) * 0.9;
      c.beginPath();
      c.moveTo(sh.verts[0][0], sh.verts[0][1]);
      for (let j = 1; j < sh.verts.length; j++) c.lineTo(sh.verts[j][0], sh.verts[j][1]);
      c.closePath();
      c.fillStyle = 'rgba(190,225,255,0.30)';
      c.fill();
      c.strokeStyle = 'rgba(255,255,255,0.8)';
      c.lineWidth = 0.8;
      c.stroke();
      c.restore();
    }
    if (this.cracks.length > 0) {
      c.save();
      c.globalCompositeOperation = 'lighter';
      c.lineWidth = 1.2;
      for (const cr of this.cracks) {
        const a = (cr.life / cr.max) * 0.85;
        c.strokeStyle = `rgba(220,240,255,${a})`;
        for (const line of cr.lines) {
          c.beginPath();
          c.moveTo(cr.x + line[0][0], cr.y + line[0][1]);
          for (let j = 1; j < line.length; j++) c.lineTo(cr.x + line[j][0], cr.y + line[j][1]);
          c.stroke();
        }
      }
      c.restore();
    }
    for (const rg of this.rings) {
      const a = rg.life / rg.max;
      c.strokeStyle = `rgba(190,235,255,${a * 0.8})`;
      c.lineWidth = 2 + a * 2;
      c.beginPath();
      c.arc(rg.x, rg.y, rg.r, 0, TAU);
      c.stroke();
    }
  }

  private drawLensOverlay(game: Game): void {
    const lt = game.lensTimeLeft;
    const on = lt > 0;
    if (on !== this.lensOn) {
      this.lensOn = on;
      this.canvas.classList.toggle('lens-on', on); // CSS handles the saturation push
    }
    if (!on) return;
    const a = Math.min(1, (TUNING.lensDuration - lt) / 0.25, lt / 0.5);
    const c = this.ctx;
    const cx = this.worldW / 2;
    const cy = WORLD_H / 2;
    const R = Math.hypot(cx, cy);
    const v = c.createRadialGradient(cx, cy, R * 0.45, cx, cy, R);
    v.addColorStop(0, 'rgba(8,8,28,0)');
    v.addColorStop(1, `rgba(8,8,28,${0.6 * a})`);
    c.fillStyle = v;
    c.fillRect(-20, -20, this.worldW + 40, WORLD_H + 40);
  }
}
