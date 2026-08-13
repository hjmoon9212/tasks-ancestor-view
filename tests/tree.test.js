'use strict';

// Pure-function tests for the ancestor tree builder in main.js.
// No dependencies: run with `npm test` (node --test).
//
// buildTree never touches the <li> it is handed - it only carries it to the
// node that matched - which is what lets the whole restructuring step be
// exercised here instead of only in Obsidian.

const test = require('node:test');
const assert = require('node:assert');

const { buildTree, childList } = require('../main.js')._internals;

// ---------------------------------------------------------------- helpers
let line = 0;
function item(over) {
    return Object.assign({
        id: '',
        description: '',
        originalMarkdown: '',
        taskLocation: { path: 'note.md', lineNumber: line++ },
        parent: null,
        children: null,
    }, over);
}
function under(parent, over) {
    const child = item(over);
    child.parent = parent;
    parent.children = (parent.children || []).concat(child);
    return child;
}
const labels = (node) => node.children.map((c) => c.item.description);

// ---------------------------------------------------------------- ancestors
test('buildTree lifts a match under its ancestor chain', () => {
    const project = item({ description: 'project' });
    const phase = under(project, { description: 'phase' });
    const leaf = under(phase, { description: 'leaf' });

    const root = buildTree([{ li: 'A', task: leaf }], {});

    assert.deepEqual(labels(root), ['project']);
    assert.equal(root.children[0].matchedLi, null);
    const found = root.children[0].children[0].children[0];
    assert.equal(found.item.description, 'leaf');
    assert.equal(found.matchedLi, 'A');
});

test('buildTree merges two matches that share an ancestor', () => {
    const project = item({ description: 'project' });
    const one = under(project, { description: 'one' });
    const two = under(project, { description: 'two' });

    const root = buildTree([{ li: 'A', task: one }, { li: 'B', task: two }], {});

    assert.equal(root.children.length, 1);
    assert.deepEqual(labels(root.children[0]), ['one', 'two']);
});

test('buildTree merges objects that point at the same source line', () => {
    // Tasks re-parses and hands back fresh objects, so the ancestor of one
    // match and the matched task of another are rarely the same reference.
    // Without itemKey merging the row renders twice - the duplicate-render bug.
    const parentA = item({ description: 'shared', taskLocation: { path: 'note.md', lineNumber: 7 } });
    const parentB = item({ description: 'shared', taskLocation: { path: 'note.md', lineNumber: 7 } });
    const childA = under(parentA, { description: 'child' });

    const root = buildTree([{ li: 'A', task: childA }, { li: 'B', task: parentB }], {});

    assert.equal(root.children.length, 1);
    assert.equal(root.children[0].matchedLi, 'B');
    assert.deepEqual(labels(root.children[0]), ['child']);
});

test('buildTree keeps matches in the order it was given', () => {
    const a = item({ description: 'a' });
    const b = item({ description: 'b' });
    const root = buildTree([{ li: 'B', task: b }, { li: 'A', task: a }], {});
    assert.deepEqual(labels(root), ['b', 'a']);
});

// ---------------------------------------------------------------- depth
test('buildTree depth 0 keeps the match alone at the top level', () => {
    const project = item({ description: 'project' });
    const leaf = under(project, { description: 'leaf' });

    const root = buildTree([{ li: 'A', task: leaf }], { depth: 0 });

    assert.deepEqual(labels(root), ['leaf']);
    assert.equal(root.children[0].matchedLi, 'A');
});

test('buildTree depth 1 keeps one ancestor', () => {
    const project = item({ description: 'project' });
    const phase = under(project, { description: 'phase' });
    const leaf = under(phase, { description: 'leaf' });

    const root = buildTree([{ li: 'A', task: leaf }], { depth: 1 });

    assert.deepEqual(labels(root), ['phase']);
    assert.deepEqual(labels(root.children[0]), ['leaf']);
});

test('buildTree treats a null depth as unlimited', () => {
    const project = item({ description: 'project' });
    const leaf = under(project, { description: 'leaf' });
    assert.deepEqual(labels(buildTree([{ li: 'A', task: leaf }], { depth: null })), ['project']);
});

// ---------------------------------------------------------------- descendants
test('buildTree expands descendants only when asked', () => {
    const leaf = item({ description: 'leaf' });
    under(leaf, { description: 'sub' });

    assert.deepEqual(labels(buildTree([{ li: 'A', task: leaf }], {}).children[0]), []);
    assert.deepEqual(
        labels(buildTree([{ li: 'A', task: leaf }], { descendants: true }).children[0]),
        ['sub']
    );
});

test('buildTree collapses a descendant that is also a match', () => {
    const leaf = item({ description: 'leaf' });
    const sub = under(leaf, { description: 'sub' });

    const root = buildTree(
        [{ li: 'A', task: leaf }, { li: 'B', task: sub }],
        { descendants: true }
    );

    assert.deepEqual(labels(root), ['leaf']);
    const subNode = root.children[0].children[0];
    assert.equal(root.children[0].children.length, 1);
    assert.equal(subNode.matchedLi, 'B');
});

test('buildTree survives a parent/child cycle in the Tasks cache', () => {
    const a = item({ description: 'a' });
    const b = under(a, { description: 'b' });
    b.children = [a];   // one bad edge used to recurse until the stack blew

    const root = buildTree([{ li: 'A', task: a }], { descendants: true });
    assert.deepEqual(labels(root), ['a']);
});

test('buildTree stops walking an endless parent chain', () => {
    const a = item({ description: 'a' });
    a.parent = a;
    const root = buildTree([{ li: 'A', task: a }], {});
    assert.equal(root.children.length, 1);
});

// ---------------------------------------------------------------- childList
test('childList reads every shape Tasks has shipped', () => {
    const one = { description: 'one' };
    const two = { description: 'two' };
    assert.deepEqual(childList([one, two]), [one, two]);
    assert.deepEqual(childList(new Map([['a', one], ['b', two]])), [one, two]);
    assert.deepEqual(childList({ a: one, b: two }), [one, two]);
    assert.deepEqual(childList(null), []);
});
