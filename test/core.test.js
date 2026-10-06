'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const core = require('../src/shared/core');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

const iso = (s) => new Date(s);

/* ---------- Peak hours (Mon-Fri 13:00-19:00 UTC) ---------- */

test('weekday inside the peak window', () => {
  const s = core.getPeakStatus(iso('2026-10-05T14:30:00Z')); // Monday
  assert.equal(s.isPeak, true);
  assert.equal(s.nextChange.toISOString(), '2026-10-05T19:00:00.000Z');
});

test('weekday before the peak window', () => {
  const s = core.getPeakStatus(iso('2026-10-05T12:59:00Z'));
  assert.equal(s.isPeak, false);
  assert.equal(s.nextChange.toISOString(), '2026-10-05T13:00:00.000Z');
});

test('peak end is exclusive', () => {
  const s = core.getPeakStatus(iso('2026-10-05T19:00:00Z'));
  assert.equal(s.isPeak, false);
  assert.equal(s.nextChange.toISOString(), '2026-10-06T13:00:00.000Z');
});

test('Friday evening jumps to Monday', () => {
  const s = core.getPeakStatus(iso('2026-10-09T20:00:00Z')); // Friday
  assert.equal(s.isPeak, false);
  assert.equal(s.nextChange.toISOString(), '2026-10-12T13:00:00.000Z');
});

test('weekend is off-peak', () => {
  const s = core.getPeakStatus(iso('2026-10-10T15:00:00Z')); // Saturday
  assert.equal(s.isPeak, false);
  assert.equal(s.nextChange.toISOString(), '2026-10-12T13:00:00.000Z');
});

test('local-day strip covers six hours on a weekday', () => {
  const segs = core.peakSegmentsForLocalDay(iso('2026-10-07T12:00:00Z')); // Wednesday
  const hours = segs.reduce((sum, s) => sum + (s.to - s.from) * 24, 0);
  assert.ok(Math.abs(hours - 6) < 0.01, `expected 6 peak hours, got ${hours}`);
  segs.forEach((s) => assert.ok(s.from >= 0 && s.to <= 1 && s.to > s.from));
});

/* ---------- Usage parsing: real claude.ai responses ---------- */

test('real response: session and Cowork limits from the structured list', () => {
  const limits = core.parseUsage(fixture('usage-enterprise-session-and-cowork.json'));
  assert.deepEqual(limits.map((l) => l.label), ['Current session', 'Weekly, Cowork']);
  assert.deepEqual(limits.map((l) => l.percent), [7, 0]);
  assert.equal(limits[0].kind, 'session');
  assert.equal(limits[1].kind, 'weekly');
  assert.equal(new Date(limits[0].resetsAt).toISOString(), '2026-10-05T23:40:00.290Z', 'microsecond timestamps parse');
});

test('real response: an organization with no limits draws no bars', () => {
  assert.deepEqual(core.parseUsage(fixture('usage-org-without-limits.json')), []);
});

test('structured list: model-scoped limits use the name claude.ai supplies', () => {
  const limits = core.parseUsage({
    limits: [
      { group: 'weekly', percent: 33, resets_at: 'x', scope: { model: { display_name: 'Fable' }, surface: null } },
      { group: 'weekly', percent: 10, resets_at: 'x', scope: null },
      { group: 'session', percent: 5, resets_at: 'x', scope: null },
      { group: 'weekly', percent: null, scope: null },
    ],
  });
  assert.deepEqual(limits.map((l) => l.label), ['Current session', 'Weekly, all models', 'Weekly, Fable']);
});

test('structured list wins over the older keys when both are present', () => {
  const limits = core.parseUsage({
    five_hour: { utilization: 99, resets_at: 'x' },
    limits: [{ group: 'session', percent: 7, resets_at: 'x', scope: null }],
  });
  assert.equal(limits.length, 1);
  assert.equal(limits[0].percent, 7);
});

test('internal codename keys are never drawn', () => {
  const limits = core.parseUsage({ tangelo: { utilization: 50, resets_at: 'x' }, iguana_necktie: { utilization: 5 }, limits: [] });
  assert.deepEqual(limits, []);
});

/* ---------- Organizations ---------- */

// Shape of a real /api/organizations response (names and ids replaced): two claude.ai
// organizations plus one API-only Console organization.
const ORGS = fixture('organizations-two-chat-one-api.json');
const UNIVERSITY = ORGS[0].uuid;
const SEAT = ORGS[2].uuid;

test('organization: API-only organizations are left out', () => {
  assert.deepEqual(core.chatOrgs(ORGS).map((o) => o.name), ['Example University', 'Premium Seat - Example University']);
});

test('organization: several claude.ai organizations and no pick means ask the user', () => {
  const d = core.resolveOrg({ orgs: ORGS, pinnedId: null });
  assert.equal(d.type, 'choose');
  assert.deepEqual(d.orgs.map((o) => o.uuid), [UNIVERSITY, SEAT]);
});

test('organization: the user pick is used while it still exists', () => {
  assert.deepEqual(core.resolveOrg({ orgs: ORGS, pinnedId: SEAT }), { type: 'chosen', uuid: SEAT });
});

test('organization: a pick that no longer exists asks again', () => {
  assert.equal(core.resolveOrg({ orgs: ORGS, pinnedId: 'left-this-org' }).type, 'choose');
});

test('organization: picking the API-only organization is not accepted', () => {
  assert.equal(core.resolveOrg({ orgs: ORGS, pinnedId: ORGS[1].uuid }).type, 'choose');
});

test('organization: a single claude.ai organization is shown without asking', () => {
  const single = [ORGS[1], ORGS[2]]; // one API org plus one chat org
  assert.deepEqual(core.resolveOrg({ orgs: single, pinnedId: null }), { type: 'single', uuid: SEAT });
});

test('organization: no claude.ai organization at all', () => {
  assert.deepEqual(core.resolveOrg({ orgs: [ORGS[1]], pinnedId: null }), { type: 'none' });
  assert.deepEqual(core.resolveOrg({ orgs: [], pinnedId: null }), { type: 'none' });
});

/* ---------- Usage parsing: older top-level keys ---------- */

const SAMPLE_MAX = {
  five_hour: { utilization: 42, resets_at: '2026-10-05T18:00:00Z' },
  seven_day: { utilization: 17.6, resets_at: '2026-10-09T09:00:00Z' },
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 5, resets_at: '2026-10-09T09:00:00Z' },
  seven_day_oauth_apps: null,
  extra_usage: { is_enabled: false, utilization: null },
};

test('parses every reported limit in a stable order', () => {
  const limits = core.parseUsage(SAMPLE_MAX);
  assert.deepEqual(limits.map((l) => l.key), ['five_hour', 'seven_day', 'seven_day_sonnet']);
  assert.deepEqual(limits.map((l) => l.label), ['Current session', 'Weekly, all models', 'Weekly, Sonnet']);
  assert.equal(limits[0].kind, 'session');
  assert.equal(limits[2].kind, 'weekly');
  assert.equal(limits[1].percent, 17.6);
});

test('free-style response with only a session limit and no active window', () => {
  const limits = core.parseUsage({ five_hour: { utilization: 0, resets_at: null }, seven_day: null });
  assert.equal(limits.length, 1);
  assert.equal(limits[0].resetsAt, null);
  assert.equal(limits[0].percent, 0);
});

test('unknown future limits still render', () => {
  const limits = core.parseUsage({ seven_day_new_model: { utilization: 150, resets_at: 'x' } });
  assert.equal(limits[0].label, 'Weekly, New Model');
  assert.equal(limits[0].percent, 100, 'percent is clamped to 100');
});

test('a Fable weekly limit appears only for accounts that report one', () => {
  const withFable = core.parseUsage({ ...SAMPLE_MAX, seven_day_fable: { utilization: 33, resets_at: '2026-10-09T09:00:00Z' } });
  assert.deepEqual(withFable.map((l) => l.label), ['Current session', 'Weekly, all models', 'Weekly, Fable', 'Weekly, Sonnet']);
  assert.equal(withFable[2].kind, 'weekly');

  const fableNull = core.parseUsage({ ...SAMPLE_MAX, seven_day_fable: null });
  assert.ok(!fableNull.some((l) => l.key === 'seven_day_fable'), 'null means no access, so no bar');

  const fableMissing = core.parseUsage(SAMPLE_MAX);
  assert.ok(!fableMissing.some((l) => l.key === 'seven_day_fable'), 'absent key means no access, so no bar');
});

test('rejects non-object responses', () => {
  assert.throws(() => core.parseUsage(null));
  assert.throws(() => core.parseUsage([]));
});

test('levels follow thresholds', () => {
  assert.equal(core.levelFor(10), 'ok');
  assert.equal(core.levelFor(60), 'warn');
  assert.equal(core.levelFor(90), 'danger');
  assert.equal(core.levelFor(50, { warnAt: 40, dangerAt: 70 }), 'warn');
});

/* ---------- Formatting ---------- */

test('duration and clock formatting', () => {
  const M = 60000;
  assert.equal(core.formatDuration(30 * 1000), '<1m');
  assert.equal(core.formatDuration(45 * M), '45m');
  assert.equal(core.formatDuration(134 * M), '2h 14m');
  assert.equal(core.formatDuration(120 * M), '2h');
  assert.equal(core.formatDuration((3 * 24 + 4) * 60 * M), '3d 4h');
  assert.equal(core.formatClock(5 * M), '5:00');
  assert.equal(core.formatClock(65 * 1000), '1:05');
  assert.equal(core.formatClock(-1), '0:00');
});

test('refresh interval is clamped', () => {
  assert.equal(core.clampRefreshMinutes(undefined), 5);
  assert.equal(core.clampRefreshMinutes(0), 1);
  assert.equal(core.clampRefreshMinutes(999), 60);
  assert.equal(core.clampRefreshMinutes('10'), 10);
});

/* ---------- Refresh scheduler ---------- */

function fakeClock() {
  let now = 0;
  const timers = new Map();
  let id = 0;
  return {
    now: () => now,
    setTimer: (fn, ms) => {
      timers.set(++id, { fn, at: now + ms });
      return id;
    },
    clearTimer: (t) => timers.delete(t),
    async advance(ms) {
      now += ms;
      for (const [key, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(key);
          t.fn();
          await new Promise((r) => setImmediate(r));
        }
      }
    },
    pending: () => timers.size,
    set: (v) => (now = v),
  };
}

const FIVE_MIN = 5 * 60 * 1000;

test('auto refresh runs every five minutes', async () => {
  const clock = fakeClock();
  const runs = [];
  const s = new core.RefreshScheduler({ intervalMs: FIVE_MIN, task: (r) => runs.push(r), ...clock });
  await s.start();
  assert.deepEqual(runs, ['startup']);
  assert.equal(s.nextAt, FIVE_MIN);
  await clock.advance(FIVE_MIN);
  assert.deepEqual(runs, ['startup', 'auto']);
  assert.equal(s.nextAt, 2 * FIVE_MIN);
  assert.equal(clock.pending(), 1, 'exactly one timer is pending');
});

test('manual refresh restarts the five-minute countdown', async () => {
  const clock = fakeClock();
  const runs = [];
  const s = new core.RefreshScheduler({ intervalMs: FIVE_MIN, task: (r) => runs.push(r), ...clock });
  await s.start(); // next auto at 5:00
  await clock.advance(3 * 60 * 1000); // 3:00, no auto yet
  await s.refreshNow('manual');
  assert.equal(s.nextAt, 3 * 60 * 1000 + FIVE_MIN, 'next auto is 5 min after the manual refresh');
  await clock.advance(2 * 60 * 1000); // 5:00: the old schedule must not fire
  assert.deepEqual(runs, ['startup', 'manual']);
  await clock.advance(3 * 60 * 1000); // 8:00
  assert.deepEqual(runs, ['startup', 'manual', 'auto']);
});

test('clicking refresh while one is running does not start a second', async () => {
  let release;
  let count = 0;
  const s = new core.RefreshScheduler({
    intervalMs: FIVE_MIN,
    task: () => {
      count += 1;
      return new Promise((r) => (release = r));
    },
    ...fakeClock(),
  });
  const a = s.refreshNow('manual');
  const b = s.refreshNow('manual');
  assert.equal(a, b);
  release();
  await a;
  assert.equal(count, 1);
});

test('a failing refresh still schedules the next one', async () => {
  const clock = fakeClock();
  const s = new core.RefreshScheduler({
    intervalMs: FIVE_MIN,
    task: async () => {
      throw new Error('offline');
    },
    ...clock,
  });
  await assert.rejects(s.refreshNow('manual'));
  assert.equal(s.nextAt, FIVE_MIN);
});

/* ---------- Desktop layer: the widget stays on the desktop ---------- */

// A fake Windows window stack, listed top to bottom as [handle, class].
function windowStack(list) {
  const stack = list.map(([h, cls]) => ({ h, cls }));
  const index = (h) => stack.findIndex((w) => w.h === h);
  return {
    classOf: (h) => (stack[index(h)] || {}).cls || '',
    windowAbove: (h) => {
      const i = index(h);
      return i > 0 ? stack[i - 1].h : 0;
    },
    // What SetWindowPos(self, insertAfter) does: move self directly below insertAfter.
    apply(self, insertAfter) {
      const [me] = stack.splice(index(self), 1);
      stack.splice(insertAfter === core.HWND_TOP ? 0 : index(insertAfter) + 1, 0, me);
    },
    order: () => stack.map((w) => w.h),
  };
}

const WIDGET = 100;
const PROGMAN = 1;

function settle(stack, foreground) {
  const plan = core.planDesktopPlacement({ self: WIDGET, foreground, progman: PROGMAN, classOf: stack.classOf, windowAbove: stack.windowAbove });
  if (plan.action === 'place') stack.apply(WIDGET, plan.insertAfter);
  return plan;
}

test('desktop: a widget raised above apps (for example after a click) drops back onto the desktop', () => {
  const stack = windowStack([[WIDGET, 'Chrome_WidgetWin_1'], [20, 'Notepad'], [30, 'CabinetWClass'], [PROGMAN, 'Progman']]);
  settle(stack, 20);
  assert.deepEqual(stack.order(), [20, 30, WIDGET, PROGMAN], 'widget sits directly above the desktop, below every app');
});

test('desktop: once in place, nothing moves', () => {
  const stack = windowStack([[20, 'Notepad'], [WIDGET, 'Chrome_WidgetWin_1'], [PROGMAN, 'Progman']]);
  assert.equal(settle(stack, 20).action, 'none');
});

test('desktop: sits above every desktop window, including the wallpaper layer', () => {
  const stack = windowStack([[20, 'Notepad'], [WIDGET, 'Chrome_WidgetWin_1'], [7, 'WorkerW'], [8, 'WorkerW'], [PROGMAN, 'Progman']]);
  settle(stack, 20);
  assert.deepEqual(stack.order(), [20, WIDGET, 7, 8, PROGMAN]);
});

test('desktop: Win+D (Show desktop) brings the widget up with the desktop', () => {
  // Windows raises a desktop window above the apps and focuses it.
  const stack = windowStack([[9, 'WorkerW'], [20, 'Notepad'], [WIDGET, 'Chrome_WidgetWin_1'], [PROGMAN, 'Progman']]);
  settle(stack, 9);
  assert.deepEqual(stack.order(), [WIDGET, 9, 20, PROGMAN], 'widget is visible on top of the shown desktop');
});

test('desktop: switching back to an app after Win+D puts the widget behind it again', () => {
  const stack = windowStack([[20, 'Notepad'], [WIDGET, 'Chrome_WidgetWin_1'], [9, 'WorkerW'], [PROGMAN, 'Progman']]);
  settle(stack, 20);
  // The raised desktop window went back down with the app restore, so the widget joins it above the desktop.
  assert.deepEqual(stack.order(), [20, WIDGET, 9, PROGMAN]);
});

test('desktop: without a desktop window to anchor to, nothing moves', () => {
  const plan = core.planDesktopPlacement({ self: WIDGET, foreground: 0, progman: 0, classOf: () => '', windowAbove: () => 0 });
  assert.equal(plan.action, 'none');
});

/* ---------- Desktop grid: the widget snaps like an icon ---------- */

const CELL = { w: 75, h: 90 };
const AREA = { x: 0, y: 0, width: 1920, height: 1032 }; // 1080p minus the taskbar

test('grid: decodes the desktop icon spacing into device-independent pixels', () => {
  assert.deepEqual(core.decodeItemSpacing((90 << 16) | 75, 1), { w: 75, h: 90 });
  assert.deepEqual(core.decodeItemSpacing((135 << 16) | 113, 1.5), { w: 75, h: 90 }, '150% scaling');
  assert.equal(core.decodeItemSpacing(0, 1), null);
  assert.equal(core.decodeItemSpacing((5 << 16) | 5, 1), null, 'nonsense values are rejected');
});

test('size: the widget is square and exactly as tall as its content', () => {
  const cell = { w: 75, h: 75 };
  for (const content of [290, 380, 514]) {
    const { width, height } = core.gridLayout({ cell, minTiles: core.MIN_TILES, contentHeight: content, inset: 4 });
    assert.equal(height, content + 8, 'no spare space above or below the content');
    assert.equal(width, height, 'square');
  }
});

test('size: never narrower than three tiles', () => {
  const short = core.gridLayout({ cell: { w: 75, h: 75 }, minTiles: core.MIN_TILES, contentHeight: 150, inset: 4 });
  assert.deepEqual(short, { width: 225, height: 158 });
});

test('size: widens for a long line instead of wrapping it', () => {
  const layout = core.gridLayout({ cell: { w: 75, h: 75 }, minTiles: core.MIN_TILES, contentHeight: 200, contentWidth: 280, inset: 4 });
  assert.deepEqual(layout, { width: 288, height: 208 });
});

test('size: the size setting zooms the whole widget', () => {
  const cell = { w: 75, h: 75 };
  const normal = core.gridLayout({ cell, minTiles: core.MIN_TILES, contentHeight: 300, contentWidth: 250, inset: 4 });
  const big = core.gridLayout({ cell, minTiles: core.MIN_TILES, contentHeight: 300, contentWidth: 250, inset: 4, scale: 1.5 });
  assert.deepEqual(normal, { width: 308, height: 308 });
  assert.deepEqual(big, { width: 462, height: 462 }, '1.5 times as big, still square');
});

test('size: the size setting stays within range, in 5% steps', () => {
  assert.equal(core.clampScale(1), 1);
  assert.equal(core.clampScale(1.33), 1.35);
  assert.equal(core.clampScale(9), core.SCALE_RANGE.max);
  assert.equal(core.clampScale(0.1), core.SCALE_RANGE.min);
  assert.equal(core.clampScale('nonsense'), 1);
});

test('size: fractional measurements round up to whole pixels', () => {
  assert.equal(core.gridLayout({ cell: CELL, minTiles: 3, contentHeight: 300.4, inset: 4 }).height, 309);
});

test('grid: a dropped widget snaps to the nearest tile', () => {
  const snapped = core.snapToGrid({ x: 190, y: 140, width: 300, height: 360 }, AREA, CELL);
  assert.deepEqual(snapped, { x: 225, y: 180 });
});

test('grid: a widget dragged past the edge stays fully on screen', () => {
  const snapped = core.snapToGrid({ x: 1900, y: 1000, width: 300, height: 360 }, AREA, CELL);
  assert.ok(snapped.x + 300 <= AREA.width && snapped.y + 360 <= AREA.height);
  assert.deepEqual(core.snapToGrid({ x: -50, y: -50, width: 300, height: 360 }, AREA, CELL), { x: 0, y: 0 });
});

test('grid: the widget can sit flush in the right and bottom corners', () => {
  // A 314px widget on a 2560 x 1392 screen with 75 x 90 tiles. The last tile that fits
  // leaves a 46px strip on the right; dropping it near the edge puts it flush instead.
  const screen = { x: 0, y: 0, width: 2560, height: 1392 };
  const size = { width: 314, height: 314 };
  const corner = core.snapToGrid({ x: 2240, y: 1070, ...size }, screen, CELL);
  assert.deepEqual(corner, { x: 2560 - 314, y: 1392 - 314 }, 'flush with the bottom-right corner');
  const topRight = core.snapToGrid({ x: 2246, y: 4, ...size }, screen, CELL);
  assert.deepEqual(topRight, { x: 2246, y: 0 }, 'flush right, on the top row');
});

test('grid: dropped nearer the last tile than the edge, it stays on the grid', () => {
  const screen = { x: 0, y: 0, width: 2560, height: 1392 };
  const snapped = core.snapToGrid({ x: 2210, y: 0, width: 314, height: 314 }, screen, CELL);
  assert.equal(snapped.x, 2175, 'last tile column (29 x 75)');
});

test('grid: tiles are measured from the work area of a second monitor', () => {
  const right = { x: 1920, y: 0, width: 2560, height: 1392 };
  const snapped = core.snapToGrid({ x: 2000, y: 100, width: 300, height: 360 }, right, CELL);
  assert.equal((snapped.x - right.x) % CELL.w, 0);
  assert.equal((snapped.y - right.y) % CELL.h, 0);
});

test('grid: a new widget starts in the top-left tile', () => {
  assert.deepEqual(core.defaultTile({ width: 300, height: 360 }, AREA, CELL), { x: 0, y: 0 });
  const right = { x: 1920, y: 0, width: 2560, height: 1392 };
  assert.deepEqual(core.defaultTile({ width: 300, height: 360 }, right, CELL), { x: 1920, y: 0 }, 'top-left of that screen');
});

/* ---------- Platforms: every OS implements the same interface ---------- */

const PLATFORM_DIR = path.join(__dirname, '..', 'src', 'main', 'platform');
const PLATFORMS = fs
  .readdirSync(PLATFORM_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

test('platforms: the Windows and fallback implementations exist', () => {
  assert.ok(PLATFORMS.includes('windows'));
  assert.ok(PLATFORMS.includes('fallback'));
});

for (const name of PLATFORMS) {
  test(`platforms: ${name} implements the interface`, () => {
    const p = require(path.join(PLATFORM_DIR, name));
    assert.equal(typeof p.name, 'string');
    for (const fn of ['widgetWindowOptions', 'pinToDesktop', 'getCell', 'prepareApp', 'trayIcon']) {
      assert.equal(typeof p[fn], 'function', `${name}.${fn}`);
    }
    assert.equal(typeof p.widgetWindowOptions(), 'object');
    assert.match(p.trayIcon('/assets'), /\.png$/);
    for (const key of ['label', 'note', 'managedElsewhere', 'managedNote']) {
      assert.ok(key in p.loginItem, `${name}.loginItem.${key}`);
    }
  });
}

/* ---------- Every source file parses ---------- */

test('all JavaScript files are syntactically valid', () => {
  const root = path.join(__dirname, '..', 'src');
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.js')) files.push(p);
    }
  })(root);
  assert.ok(files.length >= 1, "no source files found");
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${path.relative(root, f)}: ${r.stderr}`);
  }
});
