// main.ts — wiring: input, resize, visibility, the requestAnimationFrame loop.

import './style.css';
import { Game } from './game';
import { Renderer } from './render';
import { UI } from './ui';
import { audio } from './audio';

const canvas = document.querySelector<HTMLCanvasElement>('#game');
if (!canvas) throw new Error('missing #game canvas');

const renderer = new Renderer(canvas);

/** Mobile haptics; silently a no-op where unsupported (desktop, iOS Safari). */
function buzz(pattern: number | number[]): void {
  if ('vibrate' in navigator) navigator.vibrate(pattern);
}

const ui = new UI({
  onPlay: startRun,
  onRetry: startRun,
  onResume: () => setPaused(false),
  onPauseToggle: () => setPaused(game.phase === 'playing'),
});

const game = new Game({
  onFlap: () => {
    audio.flap();
    buzz(8);
    renderer.burst(game.orbX, game.orbY, 'flap');
  },
  onScore: (s) => {
    audio.score();
    buzz([12, 30, 12]);
    if (s % 10 === 0) {
      renderer.nextPalette(); // day cycle
      audio.setMood(s / 10);
    }
  },
  onNearMiss: () => {
    audio.sparkle();
    renderer.burst(game.orbX, game.orbY, 'spark');
  },
  onLens: () => audio.lens(),
  onShield: () => audio.shieldUp(),
  onShieldPop: () => {
    audio.shieldPop();
    buzz(40);
    renderer.ring(game.orbX, game.orbY);
  },
  onDeath: (score, best, newBest) => {
    audio.shatter();
    buzz(70);
    renderer.burst(game.orbX, game.orbY, 'shatter');
    ui.showGameOver(score, best, newBest);
    // Let the shatter + ghost read for a beat before the card slides in.
    window.setTimeout(() => {
      if (game.phase === 'dead') ui.setPhase('dead');
    }, 500);
  },
});

function startRun(): void {
  audio.unlock();
  audio.startMusic();
  audio.setMood(0);
  renderer.resetPalette();
  game.start();
  ui.setPhase('playing');
}

function setPaused(p: boolean): void {
  if (p && game.phase === 'playing') {
    game.togglePause();
    ui.setPhase('paused');
  } else if (!p && game.phase === 'paused') {
    game.togglePause();
    ui.setPhase('playing');
  }
}

/** One input to rule them all: tap, click, or spacebar. */
function primary(): void {
  audio.unlock();
  switch (game.phase) {
    case 'ready':
      startRun();
      break;
    case 'playing':
      game.flapInput();
      break;
    case 'paused':
      setPaused(false);
      break;
    case 'dead':
      if (game.deadFor > 0.5) startRun();
      break;
  }
}

window.addEventListener('pointerdown', (e) => {
  if (e.target instanceof Element && e.target.closest('button')) return;
  primary();
});

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.code === 'Space' || e.code === 'ArrowUp') {
    e.preventDefault();
    primary();
  } else if (e.code === 'KeyP' || e.code === 'Escape') {
    setPaused(game.phase === 'playing');
  } else if (e.code === 'KeyM') {
    ui.toggleMute();
  }
});

// Backgrounding the tab must not kill a run (and silences the pad).
document.addEventListener('visibilitychange', () => {
  if (document.hidden) setPaused(true);
  audio.setSuspended(document.hidden);
});

function onResize(): void {
  game.setSize(renderer.resize());
}
window.addEventListener('resize', onResize);
onResize();

ui.setPhase('ready');
ui.setBest(game.best);

// Dev-only handle for visual capture/tuning. Vite replaces import.meta.env.DEV
// with `false` in production, so this whole block is dead-code-eliminated.
if (import.meta.env.DEV) {
  (window as unknown as { __gg: unknown }).__gg = { game, renderer };
}

let last = performance.now();
function frame(now: number): void {
  const dt = (now - last) / 1000;
  last = now;
  game.update(dt);
  renderer.draw(game, dt);
  ui.setScore(game.score);
  ui.setPressure(game.phase === 'ready' ? 0 : game.difficulty);
  ui.setFlash(game.flash);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
