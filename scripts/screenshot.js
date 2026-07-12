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
const SAVE_PATH = path.join(OUT_DIR, 'saved-by-test.tline.json');
const OPEN_FIXTURE_PATH = path.join(OUT_DIR, 'open-fixture.tline.json');

const OPEN_FIXTURE = {
  line: { name: 'テスト線', stations: [{ id: 'X', name: 'X駅', distanceKm: 0 }, { id: 'Y', name: 'Y駅', distanceKm: 3 }] },
  trains: [{ id: 'T1', number: '999X', direction: 'down', stops: [{ stationId: 'X', arrival: null, departure: '09:00:00' }, { stationId: 'Y', arrival: '09:05:00', departure: null }] }],
};

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OPEN_FIXTURE_PATH, JSON.stringify(OPEN_FIXTURE));
  if (fs.existsSync(SAVE_PATH)) fs.unlinkSync(SAVE_PATH);

  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, TLINE_TEST_SAVE_PATH: SAVE_PATH, TLINE_TEST_OPEN_FILE: OPEN_FIXTURE_PATH },
  });
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

  // ---- File toolbar: save-as, then open a different file, then reopen via 最近使ったファイル ----
  await window.click('[data-tab="plan"]');
  await window.click('#btn-file-save-as');
  await window.waitForTimeout(200); // dialog is bypassed (TLINE_TEST_SAVE_PATH) but the IPC round-trip + fs write is still async
  const savedOk = fs.existsSync(SAVE_PATH);
  const savedContent = savedOk ? JSON.parse(fs.readFileSync(SAVE_PATH, 'utf-8')) : null;
  const saveRoundTripOk = savedOk && savedContent.trains?.length === 2 && savedContent.line.stations.length === 4;
  await window.screenshot({ path: path.join(OUT_DIR, '06-after-save-as.png') });

  await window.click('#btn-file-open');
  await window.waitForTimeout(200);
  await window.screenshot({ path: path.join(OUT_DIR, '07-after-open-fixture.png') });
  const labelAfterOpen = await window.locator('#current-file-label').textContent();

  // Recent-files dropdown should now list both files opened/saved this run.
  const recentOptions = await window.locator('#recent-files-select option').allTextContents();

  console.log('savedOk:', savedOk, 'saveRoundTripOk:', saveRoundTripOk);
  console.log('labelAfterOpen (expect open-fixture.tline.json):', labelAfterOpen);
  console.log('recentOptions:', recentOptions);

  await app.close();
  console.log(`Screenshots written to ${OUT_DIR}`);

  if (!saveRoundTripOk) throw new Error('save-as round trip failed');
  if (!labelAfterOpen.includes('open-fixture')) throw new Error('open did not switch the current file label');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
