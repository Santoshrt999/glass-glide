// ui.ts — the DOM glass layer: cards, HUD score, pressure rail, buttons.

import { audio } from './audio';
import type { Phase } from './game';

function el<T extends HTMLElement = HTMLElement>(sel: string): T {
  const e = document.querySelector<T>(sel);
  if (!e) throw new Error(`missing element ${sel}`);
  return e;
}

export interface UIHandlers {
  onPlay(): void;
  onRetry(): void;
  onResume(): void;
  onPauseToggle(): void;
}

export class UI {
  private stage = el('#stage');
  private scoreEl = el('#score');
  private railFill = el('#railFill');
  private chroma = el('#chroma');
  private startCard = el('#startCard');
  private pauseCard = el('#pauseCard');
  private overCard = el('#overCard');
  private startBest = el('#startBest');
  private overBest = el('#overBest');
  private finalScore = el('#finalScore');
  private newBestEl = el('#newBest');
  private medalEl = el('#medal');
  private medalLabel = el('#medalLabel');
  private muteBtn = el<HTMLButtonElement>('#muteBtn');

  private lastScore = -1;
  private lastPressure = -1;
  private lastFlash = -1;

  constructor(h: UIHandlers) {
    const wire = (sel: string, fn: () => void): void => {
      const b = el<HTMLButtonElement>(sel);
      // Keep button presses from also firing the global flap input.
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.addEventListener('click', () => {
        fn();
        b.blur(); // so a later spacebar flap doesn't re-trigger the button
      });
    };
    wire('#playBtn', h.onPlay);
    wire('#retryBtn', h.onRetry);
    wire('#resumeBtn', h.onResume);
    wire('#pauseBtn', h.onPauseToggle);
    wire('#muteBtn', () => this.toggleMute());
    this.setMuted(audio.muted);
  }

  toggleMute(): void {
    this.setMuted(audio.toggleMute());
  }

  private setMuted(m: boolean): void {
    this.muteBtn.classList.toggle('muted', m);
    this.muteBtn.setAttribute('aria-label', m ? 'Unmute' : 'Mute');
  }

  setPhase(phase: Phase): void {
    this.stage.dataset.phase = phase;
    this.startCard.classList.toggle('hidden', phase !== 'ready');
    this.pauseCard.classList.toggle('hidden', phase !== 'paused');
    this.overCard.classList.toggle('hidden', phase !== 'dead');
  }

  setBest(n: number): void {
    this.startBest.textContent = String(n);
  }

  setScore(n: number): void {
    if (n === this.lastScore) return;
    const grew = n > this.lastScore;
    this.lastScore = n;
    this.scoreEl.textContent = String(n);
    if (grew && n > 0) {
      this.scoreEl.classList.remove('pop');
      void this.scoreEl.offsetWidth; // restart the pop animation
      this.scoreEl.classList.add('pop');
    }
  }

  setPressure(p: number): void {
    const q = Math.round(p * 100);
    if (q === this.lastPressure) return;
    this.lastPressure = q;
    this.railFill.style.width = `${q}%`;
  }

  setFlash(a: number): void {
    const q = Math.round(a * 20) / 20;
    if (q === this.lastFlash) return;
    this.lastFlash = q;
    this.chroma.style.opacity = String(q);
  }

  showGameOver(score: number, best: number, newBest: boolean): void {
    this.finalScore.textContent = String(score);
    this.overBest.textContent = String(best);
    this.newBestEl.classList.toggle('hidden', !newBest);
    this.setMedal(score);
    this.setBest(best);
  }

  // Glass medallion tiers; below bronze the medal is simply hidden.
  private setMedal(score: number): void {
    const tier =
      score >= 40 ? 'gold' : score >= 20 ? 'silver' : score >= 8 ? 'bronze' : null;
    this.medalEl.classList.remove('bronze', 'silver', 'gold');
    this.medalEl.classList.toggle('hidden', tier === null);
    if (tier) {
      this.medalEl.classList.add(tier);
      this.medalLabel.textContent = tier;
    }
  }
}
