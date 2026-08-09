'use strict';

// Ancestor metadata (v2.9.0). Symbols are written as escapes here for the same
// reason main.js does: they are non-BMP and survive tooling better this way.

const test = require('node:test');
const assert = require('node:assert');

const { splitMetadata } = require('../main.js')._internals;

const HIGHEST = '\u{1F53A}';
const HIGH = '\u{23EB}';
const RECUR = '\u{1F501}';
const START = '\u{1F6EB}';
const DUE = '\u{1F4C5}';
const DONE = '\u{2705}';
const CREATED = '\u{2795}';
const ID = '\u{1F194}';

const byCls = (r, cls) => r.fields.filter((f) => f.cls === cls);

// ---------------------------------------------------------------- no metadata
test('splitMetadata leaves a plain description alone', () => {
    const r = splitMetadata('배치 준비');
    assert.equal(r.text, '배치 준비');
    assert.deepEqual(r.fields, []);
});

test('splitMetadata handles empty input', () => {
    assert.deepEqual(splitMetadata(''), { text: '', fields: [] });
    assert.deepEqual(splitMetadata(null), { text: '', fields: [] });
});

// ---------------------------------------------------------------- splitting
test('splitMetadata separates the description from a due date', () => {
    const r = splitMetadata(`월간 보고 ${DUE} 2026-03-31`);
    assert.equal(r.text, '월간 보고');
    assert.deepEqual(byCls(r, 'task-due')[0].value, '2026-03-31');
});

test('splitMetadata keeps fields in the order they appear', () => {
    const r = splitMetadata(`보고 ${HIGH} ${DUE} 2026-03-31 ${DONE} 2026-04-01`);
    assert.deepEqual(r.fields.map((f) => f.cls), ['task-priority', 'task-due', 'task-done']);
});

test('splitMetadata keeps a value containing spaces', () => {
    // A recurrence rule is words, not a date - a naive "take one token" split
    // would truncate it to "every".
    const r = splitMetadata(`스트레칭 ${RECUR} every day ${DUE} 2026-08-12`);
    assert.equal(byCls(r, 'task-recurring')[0].value, 'every day');
    assert.equal(byCls(r, 'task-due')[0].value, '2026-08-12');
});

test('splitMetadata gives a bare priority marker an empty value', () => {
    const r = splitMetadata(`급한 일 ${HIGHEST}`);
    assert.equal(r.text, '급한 일');
    assert.equal(byCls(r, 'task-priority')[0].value, '');
});

test('splitMetadata copes with a line that is only metadata', () => {
    const r = splitMetadata(`${DUE} 2026-03-31`);
    assert.equal(r.text, '');
    assert.equal(r.fields.length, 1);
});

test('splitMetadata finds the same symbol more than once', () => {
    // Malformed, but truncating at the first hit would hide the second.
    const r = splitMetadata(`x ${DUE} 2026-01-01 ${DUE} 2026-02-02`);
    assert.equal(byCls(r, 'task-due').length, 2);
});

test('splitMetadata trims surrounding whitespace', () => {
    const r = splitMetadata(`  보고   ${DUE}   2026-03-31   `);
    assert.equal(r.text, '보고');
    assert.equal(byCls(r, 'task-due')[0].value, '2026-03-31');
});

// ---------------------------------------------------------------- show flags
test('splitMetadata marks bookkeeping fields as hidden', () => {
    // These are what made ancestor rows unreadable: an auto-assigned id in the
    // middle of a sentence reads as a typo.
    const r = splitMetadata(`정리 ${ID} vWeZ9W ${CREATED} 2026-01-01`);
    assert.equal(byCls(r, 'task-id')[0].show, false);
    assert.equal(byCls(r, 'task-created')[0].show, false);
    assert.equal(r.text, '정리');
});

test('splitMetadata marks dates, priority and recurrence as shown', () => {
    const r = splitMetadata(`x ${HIGH} ${RECUR} every week ${START} 2026-01-01 ${DUE} 2026-01-05 ${DONE} 2026-01-06`);
    assert.ok(r.fields.every((f) => f.show), 'all of these belong on an ancestor row');
});

test('splitMetadata strips hidden fields from the description either way', () => {
    // The id sits between description and due date; the description must not
    // swallow it just because it is hidden.
    const r = splitMetadata(`회의록 작성 ${ID} abc ${DUE} 2026-05-14`);
    assert.equal(r.text, '회의록 작성');
    assert.equal(r.fields.filter((f) => f.show).length, 1);
});

test('splitMetadata reports the symbol so it can be re-rendered', () => {
    const r = splitMetadata(`x ${DUE} 2026-03-31`);
    assert.equal(r.fields[0].symbol, DUE);
});
