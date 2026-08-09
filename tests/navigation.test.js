'use strict';

// Pure-function tests for "open the ancestor's source line" (v2.2.0).
// The DOM/Obsidian side is not covered here - only the two decisions that can
// silently send the user to the wrong place: which location an item reports,
// and which line that location actually points at right now.

const test = require('node:test');
const assert = require('node:assert');

const { itemLocation, resolveLine } = require('../main.js')._internals;

// ---------------------------------------------------------------- itemLocation
test('itemLocation reads the live taskLocation shape', () => {
    assert.deepEqual(
        itemLocation({ taskLocation: { path: 'notes/a.md', lineNumber: 12 } }),
        { path: 'notes/a.md', line: 12 }
    );
});

test('itemLocation reads the underscore-prefixed cached shape', () => {
    assert.deepEqual(
        itemLocation({ _taskLocation: { _path: 'b.md', _lineNumber: 3 } }),
        { path: 'b.md', line: 3 }
    );
});

test('itemLocation accepts line 0', () => {
    // The first line of a file is a perfectly good target - a truthiness check
    // on the line number would drop it.
    assert.deepEqual(
        itemLocation({ taskLocation: { path: 'a.md', lineNumber: 0 } }),
        { path: 'a.md', line: 0 }
    );
});

test('itemLocation falls back to flat path/line fields', () => {
    assert.deepEqual(itemLocation({ path: 'c.md', lineNumber: 5 }), { path: 'c.md', line: 5 });
});

test('itemLocation returns null when either half is missing', () => {
    assert.equal(itemLocation(null), null);
    assert.equal(itemLocation({}), null);
    assert.equal(itemLocation({ path: 'a.md' }), null);                       // no line
    assert.equal(itemLocation({ taskLocation: { lineNumber: 2 } }), null);    // no path
    assert.equal(itemLocation({ path: 'a.md', lineNumber: -1 }), null);       // nonsense line
});

test('itemLocation does not fall back to filename', () => {
    // itemKey() may use `filename` as a last-resort identity, but a bare
    // filename is not a vault path and would not resolve to a file.
    assert.equal(itemLocation({ filename: 'a', lineNumber: 1 }), null);
});

// ---------------------------------------------------------------- resolveLine
const LINES = ['# Heading', '- [ ] #task alpha', '', '- [ ] #task beta'];

test('resolveLine keeps the recorded line when it still holds the text', () => {
    assert.equal(resolveLine(LINES, '- [ ] #task beta', 3), 3);
});

test('resolveLine finds the line after an edit shifted it', () => {
    const shifted = ['new line above', ...LINES];
    assert.equal(resolveLine(shifted, '- [ ] #task beta', 3), 4);
});

test('resolveLine keeps the recorded line when the text is gone', () => {
    // Better to land near the old spot than to jump somewhere arbitrary.
    assert.equal(resolveLine(LINES, '- [ ] #task deleted', 3), 3);
});

test('resolveLine refuses to guess between identical lines', () => {
    const dupes = ['- [ ] #task same', 'x', '- [ ] #task same'];
    assert.equal(resolveLine(dupes, '- [ ] #task same', 2), 2);
    // ...even when the hint points at neither of them.
    assert.equal(resolveLine(dupes, '- [ ] #task same', 1), 1);
});

test('resolveLine prefers the recorded line over an earlier duplicate', () => {
    const dupes = ['- [ ] #task same', '- [ ] #task same'];
    assert.equal(resolveLine(dupes, '- [ ] #task same', 1), 1);
});

test('resolveLine passes the hint through when there is no source text', () => {
    assert.equal(resolveLine(LINES, '', 2), 2);
    assert.equal(resolveLine(LINES, null, 2), 2);
});

test('resolveLine tolerates a hint past the end of the file', () => {
    assert.equal(resolveLine(LINES, '- [ ] #task alpha', 99), 1);
    assert.equal(resolveLine(LINES, '- [ ] #task gone', 99), 99);
});

// ---------------------------------------------------------------- findOpenLeaf
// A new-tab gesture on an already-open file should land on that tab instead of
// making a duplicate. Everything here is stubbed - the real Workspace only
// exposes `getMostRecentLeaf` for recency, so the fallbacks matter.

const { findOpenLeaf, leafFilePath } = require('../main.js')._internals;

const ROOT = { id: 'rootSplit' };
const SIDEBAR = { id: 'leftSplit' };

/** A loaded tab: the view carries the TFile. */
function leaf(path, root) {
    const l = { view: path === null ? {} : { file: { path } } };
    if (root !== undefined) l.getRoot = () => root;
    return l;
}

/** A deferred background tab: DeferredView, so only the view state has the path. */
function deferredLeaf(path, root) {
    const l = {
        view: {},
        isDeferred: true,
        getViewState: () => ({ type: 'markdown', state: { file: path } }),
    };
    if (root !== undefined) l.getRoot = () => root;
    return l;
}

function workspace(leaves, mostRecent) {
    return {
        rootSplit: ROOT,
        iterateAllLeaves: (cb) => (leaves || []).forEach(cb),
        getMostRecentLeaf: () => mostRecent ?? null,
    };
}

// ---------------------------------------------------------------- leafFilePath
test('leafFilePath reads a loaded view', () => {
    assert.equal(leafFilePath(leaf('a.md', ROOT)), 'a.md');
});

test('leafFilePath reads a deferred tab from its view state', () => {
    // The whole point: view.file is undefined until the tab is opened once.
    assert.equal(leafFilePath(deferredLeaf('a.md', ROOT)), 'a.md');
});

test('leafFilePath returns empty for a leaf with no file', () => {
    assert.equal(leafFilePath(null), '');
    assert.equal(leafFilePath({}), '');
    assert.equal(leafFilePath({ view: {} }), '');
    assert.equal(leafFilePath({ getViewState: () => ({ type: 'graph' }) }), '');
});

test('findOpenLeaf returns null when the file is not open', () => {
    assert.equal(findOpenLeaf(workspace([leaf('other.md', ROOT)]), 'a.md'), null);
    assert.equal(findOpenLeaf(workspace([]), 'a.md'), null);
});

test('findOpenLeaf finds the tab holding the file', () => {
    const hit = leaf('a.md', ROOT);
    assert.equal(findOpenLeaf(workspace([leaf('other.md', ROOT), hit]), 'a.md'), hit);
});

test('findOpenLeaf ignores sidebars and pop-out windows', () => {
    // Yanking focus to another window is worse than opening a second tab.
    assert.equal(findOpenLeaf(workspace([leaf('a.md', SIDEBAR)]), 'a.md'), null);
});

test('findOpenLeaf prefers the most recent tab when it is one of the matches', () => {
    const first = leaf('a.md', ROOT);
    const recent = leaf('a.md', ROOT);
    assert.equal(findOpenLeaf(workspace([first, recent], recent), 'a.md'), recent);
});

test('findOpenLeaf falls back to tab order when the recent leaf is unrelated', () => {
    // The usual case: the most recent leaf is the note you clicked *from*.
    const first = leaf('a.md', ROOT);
    const second = leaf('a.md', ROOT);
    const elsewhere = leaf('b.md', ROOT);
    assert.equal(findOpenLeaf(workspace([first, second], elsewhere), 'a.md'), first);
});

test('findOpenLeaf skips leaves with no file', () => {
    const hit = leaf('a.md', ROOT);
    assert.equal(findOpenLeaf(workspace([leaf(null, ROOT), hit]), 'a.md'), hit);
});

test('findOpenLeaf does not exclude leaves from an API without getRoot', () => {
    const hit = leaf('a.md');   // no getRoot
    assert.equal(findOpenLeaf(workspace([hit]), 'a.md'), hit);
});

test('findOpenLeaf survives a workspace without getMostRecentLeaf', () => {
    const hit = leaf('a.md', ROOT);
    const ws = { rootSplit: ROOT, getLeavesOfType: () => [hit] };
    assert.equal(findOpenLeaf(ws, 'a.md'), hit);
});

test('findOpenLeaf tolerates a missing or empty workspace', () => {
    assert.equal(findOpenLeaf(null, 'a.md'), null);
    assert.equal(findOpenLeaf({}, 'a.md'), null);
    assert.equal(findOpenLeaf({ rootSplit: ROOT, getLeavesOfType: () => null }, 'a.md'), null);
});

test('findOpenLeaf matches a deferred background tab', () => {
    // Regression guard for v2.4.0: matching on view.file missed every tab the
    // user had not opened since Obsidian started, so reuse never triggered.
    const hit = deferredLeaf('a.md', ROOT);
    assert.equal(findOpenLeaf(workspace([hit]), 'a.md'), hit);
});

test('findOpenLeaf excludes a deferred tab outside the main workspace', () => {
    assert.equal(findOpenLeaf(workspace([deferredLeaf('a.md', SIDEBAR)]), 'a.md'), null);
});

test('findOpenLeaf falls back to getLeavesOfType on an older API', () => {
    const hit = leaf('a.md', ROOT);
    const ws = { rootSplit: ROOT, getLeavesOfType: () => [hit] };
    assert.equal(findOpenLeaf(ws, 'a.md'), hit);
});
