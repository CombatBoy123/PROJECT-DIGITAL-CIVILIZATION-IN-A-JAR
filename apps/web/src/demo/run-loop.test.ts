import { describe, expect, it } from 'vitest';
import { MAX_TICKS_PER_FRAME, RunLoop, type FrameScheduler } from './run-loop';

class FakeScheduler implements FrameScheduler {
  private next = 1;
  pending = new Map<number, (now: number) => void>();
  request(callback: (now: number) => void): number {
    const id = this.next++;
    this.pending.set(id, callback);
    return id;
  }
  cancel(handle: number): void {
    this.pending.delete(handle);
  }
  /** Run all pending callbacks at time `now`. */
  flush(now: number): void {
    const callbacks = [...this.pending.values()];
    this.pending.clear();
    for (const cb of callbacks) cb(now);
  }
}

function fakeEngine() {
  return {
    ticks: 0,
    running: false,
    halted: null as string | null,
    step(n = 1) {
      this.ticks += n;
      return n;
    },
    setRunning(r: boolean) {
      this.running = r;
    },
  };
}

describe('RunLoop', () => {
  it('steps simulated hours per second from the tick debt', () => {
    const engine = fakeEngine();
    const scheduler = new FakeScheduler();
    const loop = new RunLoop(engine, scheduler);
    loop.setSpeed(4);
    loop.setPlaying(true);
    expect(engine.running).toBe(true);
    scheduler.flush(0); // immediate first tick
    expect(engine.ticks).toBe(1);
    for (let t = 125; t <= 1000; t += 125) scheduler.flush(t);
    expect(engine.ticks).toBe(5); // 1 + 4 per second
  });

  it('caps ticks per frame and drops large backlogs', () => {
    const engine = fakeEngine();
    const scheduler = new FakeScheduler();
    const loop = new RunLoop(engine, scheduler);
    loop.setSpeed(48);
    loop.setPlaying(true);
    scheduler.flush(0);
    scheduler.flush(10_000); // a long gap counts as 250 ms → 12 ticks owed
    expect(engine.ticks).toBe(1 + MAX_TICKS_PER_FRAME);
  });

  it('stops while hidden or paused and resumes when visible', () => {
    const engine = fakeEngine();
    const scheduler = new FakeScheduler();
    const loop = new RunLoop(engine, scheduler);
    loop.setPlaying(true);
    loop.setHidden(true);
    expect(engine.running).toBe(false);
    expect(scheduler.pending.size).toBe(0);
    loop.setHidden(false);
    expect(engine.running).toBe(true);
    loop.setPlaying(false);
    expect(scheduler.pending.size).toBe(0);
  });

  it('stops when the engine halts', () => {
    const engine = fakeEngine();
    const scheduler = new FakeScheduler();
    const loop = new RunLoop(engine, scheduler);
    loop.setPlaying(true);
    engine.halted = 'Invariant violation';
    scheduler.flush(0);
    expect(engine.ticks).toBe(0);
    expect(engine.running).toBe(false);
    expect(scheduler.pending.size).toBe(0);
  });
});
