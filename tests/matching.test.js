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
    matchItems,
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
    assert.equal(scoreEntry(prefix, 'write report', ''), 89);   // 85 + 10 * 5/12
    assert.equal(scoreEntry(inside, 'write report', ''), 70);   // 60 + 20 * 6/12
});

// Two descriptions can both be a prefix of the same rendered row - Tasks
// appends metadata after the description, so that is the normal case. The one
// accounting for more of the row is the one that owns it.
test('scoreEntry prefers the description that covers more of the row', () => {
    const full = entry({ desc: 'write quarterly report' });
    const stub = entry({ desc: 'write' });
    const rendered = 'write quarterly report 2026-08-13';

    assert.ok(scoreEntry(full, rendered, '') > scoreEntry(stub, rendered, ''));
});

test('scoreEntry falls back to originalMarkdown when description misses', () => {
    assert.equal(scoreEntry(entry({ stripped: 'write report' }), 'write report', ''), 70);
    assert.equal(scoreEntry(entry({ stripped: 'write report now' }), 'write report', ''), 48);
    assert.equal(scoreEntry(entry({ stripped: 'write' }), 'write report', ''), 34);
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
    const worse = entry({ desc: 'report', filename: 'Daily' });           // 70 + 25 = 95
    // The backlink is a tiebreak, not evidence of its own. Before the length
    // calibration a two-word description plus a filename hit outscored the task
    // that matched the row exactly, and stole it.
    assert.ok(scoreEntry(better, 'write report', 'Daily') > scoreEntry(worse, 'write report', 'Daily'));
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
});

test('buildIndex groups duplicate ids', () => {
    const tasks = [
        { id: 'dup', description: 'monthly batch', filename: 'Jan' },
        { id: 'dup', description: 'monthly batch', filename: 'Feb' },
    ];
    const index = buildIndex(tasks);
    assert.equal(index.byId.get('dup').length, 2);
    assert.equal(index.entries.length, 2);
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

// ---------------------------------------------------------------- plainify (v2.10.0)
// Both of these produced the duplicate-render signature: the source side was
// reduced to something the DOM never says, so the task went unmatched and was
// drawn twice - once appended at the end, once as a grey ancestor.
test('plainify reduces a highlight to its text', () => {
    assert.equal(plainify('review ==spec== now'), 'review spec now');
});

test('plainify drops a comment, which is never rendered at all', () => {
    assert.equal(normalizeWS(plainify('review spec %%not sure%% now')), 'review spec now');
});

test('plainify leaves unpaired markers and intra-word underscores alone', () => {
    // The DOM says "data_sync_job" too - stripping the underscores here would
    // be the mismatch, not the fix.
    assert.equal(plainify('run data_sync_job now'), 'run data_sync_job now');
    assert.equal(plainify('a * b'), 'a * b');
    assert.equal(plainify('2 _ 3'), '2 _ 3');
});

// ---------------------------------------------------------------- matchItems
function task(over) {
    return Object.assign({ id: '', description: '', originalMarkdown: '', filename: '', precedingHeader: '' }, over);
}
function li(name, over) {
    return Object.assign({ li: name, text: '', backlink: '', id: '' }, over);
}

test('matchItems gives an exact match priority over an earlier weaker one', () => {
    // The greedy pass this replaced walked in DOM order: "alpha beta" took the
    // only candidate it had, and the row that matched it exactly was stranded.
    const t1 = task({ description: 'alpha' });
    const index = buildIndex([t1]);
    const a = li('A', { text: 'alpha beta' });
    const b = li('B', { text: 'alpha' });

    const out = matchItems(index, [a, b]);
    assert.equal(out.matches.length, 1);
    assert.equal(out.matches[0].item.li, 'B');
    assert.equal(out.matches[0].entry.task, t1);
    assert.deepEqual(out.unmatched.map((u) => u.li), ['A']);
});

test('matchItems lets an id claim its task before any text match', () => {
    const owned = task({ id: 'abc', description: 'monthly batch report' });
    const other = task({ description: 'monthly batch' });
    const index = buildIndex([owned, other]);
    // Both rows render the same text, and A would take `owned` outright on an
    // exact text hit - but the id on B is proof of ownership, so A has to
    // settle for the weaker candidate.
    const a = li('A', { text: 'monthly batch report' });
    const b = li('B', { text: 'monthly batch report', id: 'abc' });

    const out = matchItems(index, [a, b]);
    assert.equal(out.matches.length, 2);
    const byLi = new Map(out.matches.map((m) => [m.item.li, m.entry.task]));
    assert.equal(byLi.get('B'), owned);
    assert.equal(byLi.get('A'), other);
});

test('matchItems returns matches in the caller order, not id-first order', () => {
    // The tree is built from this list, so its order is the rendered order -
    // it has to stay the order the Tasks query produced.
    const plain = task({ description: 'plain row' });
    const owned = task({ id: 'abc', description: 'owned row' });
    const index = buildIndex([plain, owned]);

    const out = matchItems(index, [li('A', { text: 'plain row' }), li('B', { text: 'owned row', id: 'abc' })]);
    assert.deepEqual(out.matches.map((m) => m.item.li), ['A', 'B']);
});

test('matchItems falls back to text when the id is unknown', () => {
    const t1 = task({ description: 'write report' });
    const out = matchItems(buildIndex([t1]), [li('A', { text: 'write report', id: 'gone' })]);
    assert.equal(out.matches.length, 1);
    assert.equal(out.matches[0].entry.task, t1);
});

test('matchItems refuses a task whose id contradicts the rendered one', () => {
    const t1 = task({ id: 'yyy', description: 'write report' });
    const out = matchItems(buildIndex([t1]), [li('A', { text: 'write report', id: 'xxx' })]);
    assert.equal(out.matches.length, 0);
    assert.deepEqual(out.unmatched.map((u) => u.li), ['A']);
});

test('matchItems tiebreaks a duplicated id on the backlink', () => {
    // gcal-sync assigns ids automatically, so the same id can sit on several
    // source lines; the backlink is the only thing left to tell them apart.
    const jan = task({ id: 'dup', description: 'monthly batch', filename: 'Jan' });
    const feb = task({ id: 'dup', description: 'monthly batch', filename: 'Feb' });
    const index = buildIndex([jan, feb]);

    const out = matchItems(index, [li('A', { text: 'monthly batch', id: 'dup', backlink: 'Feb > Today' })]);
    assert.equal(out.matches[0].entry.task, feb);
});

test('matchItems never hands the same task to two rows', () => {
    const t1 = task({ description: 'shared row' });
    const out = matchItems(buildIndex([t1]), [li('A', { text: 'shared row' }), li('B', { text: 'shared row' })]);
    assert.equal(out.matches.length, 1);
    assert.equal(out.unmatched.length, 1);
});

test('matchItems is stable for identical input', () => {
    const tasks = [task({ description: 'row one' }), task({ description: 'row one extra' })];
    const index = buildIndex(tasks);
    const pending = [li('A', { text: 'row one extra' }), li('B', { text: 'row one' })];
    const first = matchItems(index, pending).matches.map((m) => m.item.li + ':' + m.entry.desc);
    const again = matchItems(index, pending).matches.map((m) => m.item.li + ':' + m.entry.desc);
    assert.deepEqual(first, again);
});
