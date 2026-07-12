'use strict';

// Dev-only tool: launches the app via Playwright's Electron driver and saves
// a screenshot of each tab (plus the 運転整理 form after applying an
// adjustment) to .tmp-screenshots/, so a GUI-blind session can still verify
// what actually renders instead of relying only on code review + node
// --check. Not part of the shipped app; only ever run manually/ad-hoc.
//
// Usage: node scripts/screenshot.js

const path = require('path');
const fs = require('fs');
const { _electron: electron } = require('playwright');

const OUT_DIR = path.join(__dirname, '..', '.tmp-screenshots');

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const app = await electron.launch({ args: [path.join(__dirname, '..')] });
  const window = await app.firstWindow();
  await window.waitForLoadState('load');

  await window.screenshot({ path: path.join(OUT_DIR, '01-plan.png') });

  await window.click('[data-tab="dispatch"]');
  await window.screenshot({ path: path.join(OUT_DIR, '02-dispatch-before.png') });

  // Exercise the 運転整理 form: pick the second train's second stop, apply a
  // +120s delay, and screenshot the overlay (original + dashed adjusted line).
  await window.selectOption('#dispatch-station', { index: 1 });
  await window.fill('#dispatch-delta', '120');
  await window.click('#dispatch-form button[type="submit"]');
  await window.screenshot({ path: path.join(OUT_DIR, '03-dispatch-after.png') });

  await window.click('[data-tab="actual"]');
  await window.screenshot({ path: path.join(OUT_DIR, '04-actual.png') });

  // Type an actual arrival time into the first editable input to check the
  // delta column renders (positive/negative coloring).
  const firstInput = window.locator('#actual-table input').first();
  if (await firstInput.count()) {
    await firstInput.fill('08:09:12');
    await firstInput.dispatchEvent('change');
    await window.screenshot({ path: path.join(OUT_DIR, '05-actual-with-delta.png') });
  }

  await app.close();
  console.log(`Screenshots written to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
