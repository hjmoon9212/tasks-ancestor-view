'use strict';

// Pure-function tests for settings loading (v2.3.0).
// data.json is hand-editable and survives downgrades, so the merge has to cope
// with missing keys, keys from a future version, and outright junk.

const test = require('node:test');
const assert = require('node:assert');

const { DEFAULT_SETTINGS, clampDebounce, mergeSettings } = require('../main.js')._internals;

// ---------------------------------------------------------------- clampDebounce
test('clampDebounce keeps a sane value as-is', () => {
    assert.equal(clampDebounce(400, 400), 400);
    assert.equal(clampDebounce(50, 400), 50);
    assert.equal(clampDebounce(5000, 400), 5000);
});

test('clampDebounce pulls out-of-range values to the bounds', () => {
    assert.equal(clampDebounce(0, 400), 50);
    assert.equal(clampDebounce(-100, 400), 50);
    assert.equal(clampDebounce(60000, 400), 5000);
});

test('clampDebounce accepts numeric strings from the text input', () => {
    assert.equal(clampDebounce('250', 400), 250);
    assert.equal(clampDebounce('250.7', 400), 250);
});

test('clampDebounce falls back on junk', () => {
    assert.equal(clampDebounce('abc', 400), 400);
    assert.equal(clampDebounce('', 400), 400);
    assert.equal(clampDebounce(null, 400), 400);
    assert.equal(clampDebounce(undefined, 400), 400);
    assert.equal(clampDebounce(NaN, 400), 400);
    assert.equal(clampDebounce(Infinity, 400), 400);
});

test('clampDebounce rounds fractional values', () => {
    assert.equal(clampDebounce(399.6, 400), 400);
});

// ---------------------------------------------------------------- mergeSettings
test('mergeSettings returns the defaults for a fresh install', () => {
    assert.deepEqual(mergeSettings(null), DEFAULT_SETTINGS);
    assert.deepEqual(mergeSettings(undefined), DEFAULT_SETTINGS);
    assert.deepEqual(mergeSettings({}), DEFAULT_SETTINGS);
});

test('mergeSettings does not mutate or alias the defaults', () => {
    const merged = mergeSettings({});
    merged.debounceMs = 999;
    assert.equal(DEFAULT_SETTINGS.debounceMs, 400);
});

test('mergeSettings keeps saved values', () => {
    const merged = mergeSettings({ debounceMs: 800, showDescendants: false, clickToOpen: false, debug: true });
    assert.deepEqual(merged, { debounceMs: 800, showDescendants: false, clickToOpen: false, debug: true });
});

test('mergeSettings fills only the missing keys', () => {
    // A file written by an older version has no clickToOpen at all - that must
    // read as "on", not "off".
    const merged = mergeSettings({ debounceMs: 200 });
    assert.equal(merged.debounceMs, 200);
    assert.equal(merged.clickToOpen, true);
    assert.equal(merged.showDescendants, true);
    assert.equal(merged.debug, false);
});

test('mergeSettings treats only an explicit false as off', () => {
    // Truthiness would turn every absent/odd value into off.
    assert.equal(mergeSettings({ showDescendants: undefined }).showDescendants, true);
    assert.equal(mergeSettings({ showDescendants: null }).showDescendants, true);
    assert.equal(mergeSettings({ showDescendants: false }).showDescendants, false);
});

test('mergeSettings coerces debug to a boolean', () => {
    assert.equal(mergeSettings({ debug: 1 }).debug, true);
    assert.equal(mergeSettings({ debug: 0 }).debug, false);
    assert.equal(mergeSettings({ debug: 'yes' }).debug, true);
});

test('mergeSettings repairs a corrupt debounce', () => {
    assert.equal(mergeSettings({ debounceMs: 'abc' }).debounceMs, DEFAULT_SETTINGS.debounceMs);
    assert.equal(mergeSettings({ debounceMs: 0 }).debounceMs, 50);
});

test('mergeSettings carries unknown keys through untouched', () => {
    // Downgrading should not wipe a newer version's settings out of data.json.
    assert.equal(mergeSettings({ futureOption: 'x' }).futureOption, 'x');
});
