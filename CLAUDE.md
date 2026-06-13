# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install        # install Vite + TypeScript (the only dependencies)
npm run dev        # dev server at http://localhost:5173
npm run build      # strict tsc type-check, then Vite production build → dist/
npm run preview    # serve the built dist/ locally
```

There is **no test suite and no separate linter**. `npm run build` is the gate: it runs `tsc` in `strict` mode with `noUnusedLocals`/`noUnusedParameters`, so editing the canvas code often fails the build on orphaned locals — always run `npm run build` after changes to `render.ts`.

## Architecture

A single-page browser game in vanilla TypeScript with **zero runtime dependencies** — only the Canvas2D and WebAudio APIs. Five modules with a strict separation of concerns wired together in `main.ts`.

### Module boundaries (do not blur these)

- **`game.ts`** — all state, physics, difficulty, collisions. Pure logic: it imports no DOM and does no rendering. Side effects to the outside world happen only through the `GameHooks` callback interface.
- **`render.ts`** — all Canvas2D drawing. Reads game state; never mutates it.
- **`audio.ts`** — all WebAudio synthesis (SFX + a generative ambient pad). Exports a singleton `audio`.
- **`ui.ts`** — the DOM glass layer (cards, HUD, pressure rail, medals). Owns everything outside the canvas.
- **`main.ts`** — the only place that knows about all four. It owns the `requestAnimationFrame` loop, input, resize, and visibility, and wires `Game`'s hooks to `audio`/`render`/`ui`. New cross-module behavior belongs here, fired via a hook — not by having `game.ts` reach into rendering or audio.

### Virtual-world coordinate system

Physics run in a fixed virtual world that is always `WORLD_H` (720) units tall; `render.ts` computes a scale factor and maps world units to device pixels. This makes the game both **framerate-independent** (delta-time physics, clamped) and **resolution-independent** (same feel on every screen). When adding anything positional, work in world units and let the renderer scale — never hardcode device pixels in `game.ts`.

### Two clocks (subtle — easy to break)

`Game` tracks **two** time bases:
- `time` — *world* time, which runs at half speed during lens (slow-mo) mode. Drives anything that should slow down: scrolling, pillar drift, the orb's bobbing.
- `realTime` — wall-clock play time. Drives effect timers (shake, flash), the ghost-replay cursor, and trail timestamps, so slow-mo doesn't stretch them.

Effect decay in `update()` uses `dtReal`; world motion uses `dt = dtReal * timeScale`. Mixing these up causes slow-mo to wrongly speed up or slow down effects.

### The glass-rendering strategy (the core performance decision)

Real CSS `backdrop-filter` is reserved **only** for static DOM UI panels in `style.css` (never more than ~4 on screen at once). Pillars and the lens are a **canvas fake**: the drifting-blob background is drawn to a small offscreen canvas (~1/5 resolution), and each pillar/lens samples it back *magnified* through a clip — the upscale gives free blur, the magnification reads as refraction. This is what holds 60fps with many pillars. **Do not "improve" pillars by giving them real `backdrop-filter`** — that was deliberately rejected (see the header comment in `render.ts`). The watery shimmer (`wavyBg`), caustics, and wavy cap edges build on this same offscreen-sampling trick.

### Reduced motion

`prefers-reduced-motion` must disable screen shake, blob drift, and all wave/caustic animation. `render.ts` checks `this.reducedMotion`; any new motion effect must honor it.

### Tuning

`game.ts` opens with a `TUNING` object — the central home for gameplay feel (gravity, flap impulse, gap/speed difficulty ramp, pickup cadence, drift, graze band). Medal thresholds live in `ui.ts`; ambient-pad volume/tempo at the top of `audio.ts`; wave amplitudes inline in `render.ts`.

### Conventions worth keeping

- Pickups bob via the shared `pickupBobY()` so the rendered sprite and the collision hitbox always agree — don't compute the bob separately in either place.
- `main.ts` exposes a dev-only `__gg` handle guarded by `import.meta.env.DEV`; Vite dead-code-eliminates it from production builds (verified absent in `dist/`). Useful for scripted visual capture.
- Persisted state in `localStorage`: best score (`glassglide.best`) and mute (`glassglide.muted`).

## Deployment

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds and deploys `dist/` to GitHub Pages at https://santoshrt999.github.io/glass-glide/. `vite.config.ts` sets `base: '/glass-glide/'` **only for `command === 'build'`** so production assets resolve on the Pages subpath while local dev stays at `/`. If the repo is ever renamed, that `base` must change to match or the live page breaks (blank page, 404 assets).
