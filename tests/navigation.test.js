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
