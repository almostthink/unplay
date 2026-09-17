/**
 * Drift physics regression test.
 *
 * Runs the real CarPhysics module at a fixed 60 Hz step with no renderer, so
 * the results are deterministic and independent of frame rate. Start the dev
 * server first (`npm run dev`), then `npm run test:physics`.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
await page.goto(process.env.DEV_URL || 'http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

// Run the real physics module at a fixed 60 Hz step, with no renderer involved.
const out = await page.evaluate(async () => {
  const { CarPhysics } = await import('/src/drift/car.ts');
  const stats = { topSpeed: 42, accel: 15, grip: 3.1, steer: 2.1 };

  const sim = (steer, handbrake, seconds, offRoad = false) => {
    const p = new CarPhysics(stats);
    p.reset(0, 0, 0, 0);
    const dt = 1 / 60;
    let maxDrift = 0;
    let scoringDrift = 0;
    let maxSpeed = 0;
    for (let i = 0; i < seconds * 60; i++) {
      // Two seconds of straight-line acceleration, then apply the steering.
      const s = i < 120 ? 0 : steer;
      p.step(dt, { steer: s, handbrake: i < 120 ? false : handbrake, nitro: false }, offRoad);
      if (i > 120) maxDrift = Math.max(maxDrift, Math.abs(p.driftAngle));
      // A drift only scores when it happens above the scoring speed floor.
      if (i > 120 && p.speed > 14) scoringDrift = Math.max(scoringDrift, Math.abs(p.driftAngle));
      maxSpeed = Math.max(maxSpeed, p.speed);
    }
    return { maxDrift, scoringDrift, maxSpeed, endSpeed: p.speed, x: p.x, z: p.z, yaw: p.yaw };
  };

  // A real corner: turn in, hold, then straighten and recover.
  const corner = () => {
    const p = new CarPhysics(stats);
    p.reset(0, 0, 0, 0);
    const dt = 1 / 60;
    let scoringDrift = 0;
    let driftFrames = 0;
    for (let i = 0; i < 12 * 60; i++) {
      const s = i < 120 ? 0 : i < 300 ? 0.75 : 0;
      p.step(dt, { steer: s, handbrake: false, nitro: false }, false);
      if (i > 120 && p.speed > 14 && Math.abs(p.driftAngle) > 0.22) {
        scoringDrift = Math.max(scoringDrift, Math.abs(p.driftAngle));
        driftFrames++;
      }
    }
    return { scoringDrift, driftSeconds: driftFrames / 60, recovered: p.speed };
  };

  const straight = sim(0, false, 12);
  const gentle = sim(0.35, false, 12);
  const hard = sim(1, false, 12);
  const hardBrake = sim(1, true, 12);
  const offroad = sim(0, false, 12, true);
  return { straight, gentle, hard, hardBrake, offroad, corner: corner() };
});

const r = (n) => Math.round(n * 1000) / 1000;
const DRIFT_ANGLE_MIN = 0.22;
console.log('straight  : topSpeed', r(out.straight.maxSpeed), 'drift', r(out.straight.maxDrift));
console.log('gentle    : drift', r(out.gentle.maxDrift), 'speed', r(out.gentle.endSpeed));
console.log('hard      : drift', r(out.hard.maxDrift), 'speed', r(out.hard.endSpeed));
console.log('handbrake : drift', r(out.hardBrake.maxDrift), 'speed', r(out.hardBrake.endSpeed));
console.log('offroad   : topSpeed', r(out.offroad.maxSpeed));
console.log('corner    : scoringDrift', r(out.corner.scoringDrift),
            'driftSeconds', r(out.corner.driftSeconds),
            'recovered', r(out.corner.recovered));

const checks = [
  ['straight line reaches near top speed', out.straight.maxSpeed > 38 && out.straight.maxSpeed <= 43],
  ['straight line does not drift', out.straight.maxDrift < 0.01],
  ['gentle steering stays gripped', out.gentle.maxDrift < DRIFT_ANGLE_MIN],
  ['hard steering breaks into a drift', out.hard.maxDrift > DRIFT_ANGLE_MIN],
  ['handbrake drifts harder than without', out.hardBrake.maxDrift > out.hard.maxDrift],
  ['drifting scrubs speed', out.hard.endSpeed < out.straight.maxSpeed],
  ['off-road caps speed lower', out.offroad.maxSpeed < out.straight.maxSpeed * 0.7],
  ['car actually turns', Math.abs(out.hard.yaw) > 1],
  ['hard turn drifts while still fast enough to score', out.hard.scoringDrift > DRIFT_ANGLE_MIN],
  ['a real corner scores a drift', out.corner.scoringDrift > DRIFT_ANGLE_MIN],
  ['a corner holds the drift for over a second', out.corner.driftSeconds > 1],
  ['straightening recovers speed', out.corner.recovered > 34],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
console.log(failed ? `${failed} CHECK(S) FAILED` : 'ALL PHYSICS CHECKS PASSED');
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
