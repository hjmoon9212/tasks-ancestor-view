'use strict';

// Pure-function tests for the matching helpers in main.js.
// No dependencies: run with `npm test` (node --test).
//
// main.js wraps its require('obsidian') in a try/catch precisely so it can
// be loaded here; only exports._internals is exercised.

const test = require('node:test');
const assert = require('node:assert');

const {
    stripCheckbox,
    normalizeWS,
    plainify,
    itemKey,
    backlinkBonus,
    scoreEntry,
    buildIndex,
} = require('../main.js')._internals;

// ---------------------------------------------------------------- helpers
function entry(over) {
    return Object.assign({ desc: '', stripped: '', filename: '', heading: '', id: '' }, over);
}

// ---------------------------------------------------------------- stripCheckbox
test('stripCheckbox removes task checkboxes', () => {
    assert.equal(stripCheckbox('- [ ] #task write report'), '#task write report');
    assert.equal(stripCheckbox('  * [x] done thing'), 'done thing');
    assert.equal(stripCheckbox('\t- [/] in progress'), 'in progress');
});

test('stripCheckbox removes plain and numbered list markers', () => {
    assert.equal(stripCheckbox('    - group A'), 'group A');
    assert.equal(stripCheckbox('* group B'), 'group B');
    assert.equal(stripCheckbox('3. third item'), 'third item');
    assert.equal(stripCheckbox('3) third item'), 'third item');
});

test('stripCheckbox removes a trailing block anchor', () => {
    assert.equal(stripCheckbox('- [ ] task text ^abc-123'), 'task text');
    // A caret inside the text is not a block anchor and must survive.
    assert.equal(stripCheckbox('- [ ] 2^10 exponent'), '2^10 exponent');
});

test('stripCheckbox tolerates empty input', () => {
    assert.equal(stripCheckbox(''), '');
    assert.equal(stripCheckbox(null), '');
    assert.equal(stripCheckbox(undefined), '');
});

// ---------------------------------------------------------------- normalizeWS
test('normalizeWS collapses whitespace runs and trims', () => {
    assert.equal(normalizeWS('  a   b \n c\t'), 'a b c');
    assert.equal(normalizeWS(null), '');
});

// ---------------------------------------------------------------- plainify
// Regression guard for the duplicate-render bug: a task whose description
// contains a markdown link renders as label-only in the DOM, so the source
// text must be reduced the same way before comparison.
test('plainify reduces markdown links to their rendered label', () => {
    assert.equal(plainify('[Sync guide](https://example.com/a?b=c)'), 'Sync guide');
    assert.equal(plainify('see [docs](http://x) now'), 'see docs now');
    assert.equal(plainify('![alt](image.png)'), 'alt');
});

test('plainify reduces wikilinks, with and without alias', () => {
    assert.equal(plainify('[[Project Note|the project]]'), 'the project');
    assert.equal(plainify('[[Project Note]]'), 'Project Note');
    assert.equal(plainify('![[Embedded Note]]'), 'Embedded Note');
});

test('plainify strips emphasis and code markers', () => {
    assert.equal(plainify('**bold** and _em_ and `code` and ~~gone~~'), 'bold and em and code and gone');
});

test('plainify strips inline HTML tags', () => {
    assert.equal(plainify('a <span class="x">b</span> c'), 'a b c');
});

test('plainify handles a combined description end to end', () => {
    const source = '#task **review** [spec](https://x.y/z) for [[Q3 Plan|Q3]]';
    assert.equal(normalizeWS(plainify(source)), '#task review spec for Q3');
});

test('plainify leaves plain text untouched', () => {
    assert.equal(plainify('#task monthly batch'), '#task monthly batch');
    assert.equal(plainify(null), '');
});

// ---------------------------------------------------------------- itemKey
test('itemKey prefers the task id over everything else', () => {
    const key = itemKey({ id: 'vFS1gd', taskLocation: { path: 'a.md', lineNumber: 3 } });
    assert.equal(key, 'id:vFS1gd');
});

test('itemKey falls back to source location', () => {
    assert.equal(itemKey({ taskLocation: { path: 'a.md', lineNumber: 7 } }), 'loc:a.md:7');
    assert.equal(itemKey({ _taskLocation: { _path: 'b.md', _lineNumber: 0 } }), 'loc:b.md:0');
});

test('itemKey falls back to markdown text when no location exists', () => {
    assert.equal(itemKey({ originalMarkdown: '- [ ] x' }), 'md:- [ ] x|');
});

test('itemKey returns empty string for a missing item', () => {
    assert.equal(itemKey(null), '');
    assert.equal(itemKey(undefined), '');
});

test('itemKey ignores a blank id and keeps looking', () => {
    assert.equal(itemKey({ id: '   ', taskLocation: { path: 'a.md', lineNumber: 1 } }), 'loc:a.md:1');
});

// ---------------------------------------------------------------- backlinkBonus
test('backlinkBonus rewards a filename hit and a heading hit', () => {
    const e = entry({ filename: 'Daily', heading: 'Today' });
    assert.equal(backlinkBonus(e, ''), 0);
    assert.equal(backlinkBonus(e, 'Daily'), 25);
    assert.equal(backlinkBonus(e, 'Daily > Today'), 35);
    assert.equal(backlinkBonus(e, 'Other > Today'), 10);
});

// ---------------------------------------------------------------- scoreEntry
test('scoreEntry ranks description matches above markdown fallbacks', () => {
    const exact = entry({ desc: 'write report' });
    const prefix = entry({ desc: 'write' });
    const inside = entry({ desc: 'report' });

    assert.equal(scoreEntry(exact, 'write report', ''), 100);
    assert.equal(scoreEntry(prefix, 'write report', ''), 95);
    assert.equal(scoreEntry(inside, 'write report', ''), 80);
});

test('scoreEntry falls back to originalMarkdown when description misses', () => {
    assert.equal(scoreEntry(entry({ stripped: 'write report' }), 'write report', ''), 70);
    assert.equal(scoreEntry(entry({ stripped: 'write report now' }), 'write report', ''), 50);
    assert.equal(scoreEntry(entry({ stripped: 'write' }), 'write report', ''), 40);
});

test('scoreEntry returns 0 when nothing matches', () => {
    assert.equal(scoreEntry(entry({ desc: 'unrelated' }), 'write report', 'Daily'), 0);
});

test('scoreEntry adds the backlink bonus only to a real match', () => {
    const hit = entry({ desc: 'write report', filename: 'Daily' });
    const miss = entry({ desc: 'unrelated', filename: 'Daily' });
    assert.equal(scoreEntry(hit, 'write report', 'Daily'), 125);
    assert.equal(scoreEntry(miss, 'write report', 'Daily'), 0);
});

test('scoreEntry keeps the better description over the better backlink', () => {
    const better = entry({ desc: 'write report' });                       // 100
    const worse = entry({ desc: 'report', filename: 'Daily' });           // 80 + 25 = 105
    // The backlink bonus is a tiebreak and CAN outrank a weaker text hit -
    // this pins that intent so a future bonus change is a deliberate one.
    assert.ok(scoreEntry(worse, 'write report', 'Daily') > scoreEntry(better, 'write report', 'Daily'));
});

// ---------------------------------------------------------------- buildIndex
test('buildIndex normalizes descriptions and indexes by id', () => {
    const tasks = [
        {
            id: 'vFS1gd',
            description: '#task **review** [spec](https://x.y)',
            originalMarkdown: '- [ ] #task **review** [spec](https://x.y)',
            filename: 'Plan',
            precedingHeader: 'Today',
        },
    ];
    const index = buildIndex(tasks);

    assert.equal(index.entries.length, 1);
    assert.equal(index.entries[0].desc, '#task review spec');
    assert.equal(index.entries[0].stripped, '#task review spec');
    assert.equal(index.entries[0].filename, 'Plan');
    assert.equal(index.entries[0].heading, 'Today');
    assert.deepEqual(index.byId.get('vFS1gd'), [index.entries[0]]);
    assert.deepEqual(index.byDesc.get('#task review spec'), [index.entries[0]]);
});

test('buildIndex groups duplicate ids and duplicate descriptions', () => {
    const tasks = [
        { id: 'dup', description: 'monthly batch', filename: 'Jan' },
        { id: 'dup', description: 'monthly batch', filename: 'Feb' },
    ];
    const index = buildIndex(tasks);
    assert.equal(index.byId.get('dup').length, 2);
    assert.equal(index.byDesc.get('monthly batch').length, 2);
});

test('buildIndex skips tasks with no usable text', () => {
    const index = buildIndex([{ description: '', originalMarkdown: '' }, { description: 'ok' }]);
    assert.equal(index.entries.length, 1);
    assert.equal(index.entries[0].desc, 'ok');
});

test('buildIndex leaves an id-less task out of byId', () => {
    const index = buildIndex([{ description: 'no id here' }]);
    assert.equal(index.byId.size, 0);
    assert.equal(index.entries.length, 1);
});
