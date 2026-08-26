// Realistic timing model — the core of "runs last realistic time, not a burst".
//
// Every candidate action is wrapped in a human-cadence delay derived from the
// action itself (reading is proportional to text length, composing to output
// length) with per-action Gaussian jitter so no two runs are identical. A
// SPEED multiplier scales all delays: SPEED=1.0 is real time (default),
// SPEED=0.1 is a fast validation pass. This is what lets sessions accrue real
// active minutes and clear the scorability floor (minActiveMinutes: 10)
// legitimately instead of firing actions instantly.
//
// Determinism: no Math.random() in the harness runtime is forbidden here
// (unlike workflow scripts), but to keep runs reproducible per seed we use a
// small seeded PRNG so a rerun with the same seed paces identically.

export interface PacerOpts {
  speed: number; // multiplier on all sleeps; 1.0 = real time
  wpm: number; // reading speed (words/min); slower for weaker personas
  charsPerSec: number; // "typing + revising" throughput when composing
  distraction: number; // 0..1 — extra idle-gap probability (weaker/anxious personas)
  seed: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Mulberry32 — tiny deterministic PRNG so a seed reproduces the same pacing. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Pacer {
  private rnd: () => number;
  private accruedMs = 0;
  constructor(private opts: PacerOpts) {
    this.rnd = mulberry32(opts.seed);
  }

  /** Total real time this pacer has slept — used to log realistic duration. */
  get accruedSeconds(): number { return Math.round(this.accruedMs / 1000); }

  private jitter(base: number, spread = 0.35): number {
    // Approximate normal via averaging two uniforms; clamp to [0.4x, 1.8x].
    const n = (this.rnd() + this.rnd()) / 2; // ~triangular around 0.5
    const factor = 1 + (n - 0.5) * 2 * spread;
    return base * Math.max(0.4, Math.min(1.8, factor));
  }

  private async pause(seconds: number): Promise<void> {
    const ms = Math.max(0, seconds) * 1000 * this.opts.speed;
    this.accruedMs += ms / this.opts.speed; // track REAL-time equivalent, not scaled
    await sleep(ms);
  }

  /** Reading N characters of text (docs, query results, persona replies). */
  async read(text: string): Promise<void> {
    const words = Math.max(1, text.split(/\s+/).length);
    const base = (words / this.opts.wpm) * 60;
    await this.pause(this.jitter(base));
  }

  /** Composing an output of N characters (a message, a SQL query, a code edit). */
  async compose(chars: number): Promise<void> {
    const base = chars / this.opts.charsPerSec;
    await this.pause(this.jitter(base, 0.45));
  }

  /** A short "thinking / deciding what to do next" gap between actions, plus an
   *  occasional longer "stuck" gap for distractible personas. */
  async think(): Promise<void> {
    let base = 3 + this.rnd() * 9; // 3–12s
    if (this.rnd() < this.opts.distraction * 0.3) base += 20 + this.rnd() * 40; // stuck
    await this.pause(this.jitter(base));
  }

  /** Reading the brief at the start — a real chunk of orientation time. */
  async orient(briefChars: number): Promise<void> {
    const words = Math.max(50, briefChars / 5);
    const base = (words / this.opts.wpm) * 60 + 20; // read + settle in
    await this.pause(this.jitter(base));
  }
}

/** Persona-shaped pacing profiles. Weaker/anxious personas read slower, type
 *  slower, and idle more — which naturally produces longer, messier sessions. */
export function pacerFor(skill: string, speed: number, seed: number): Pacer {
  const table: Record<string, Omit<PacerOpts, "speed" | "seed">> = {
    strong:     { wpm: 320, charsPerSec: 9.0, distraction: 0.05 },
    above_avg:  { wpm: 280, charsPerSec: 8.0, distraction: 0.10 },
    median:     { wpm: 240, charsPerSec: 6.5, distraction: 0.20 },
    below_avg:  { wpm: 210, charsPerSec: 5.5, distraction: 0.30 },
    weak:       { wpm: 180, charsPerSec: 4.5, distraction: 0.45 },
  };
  const p = table[skill] ?? table.median!;
  return new Pacer({ ...p, speed, seed });
}
