'use strict';

// Block directives (v2.8.0). The risk here is not the parsing - it is
// consuming a line that belonged to Tasks. A dropped filter changes which
// tasks appear, silently, so most of these assert the query passes through.

const test = require('node:test');
const assert = require('node:assert');

const { parseDirectives, trimChain } = require('../main.js')._internals;

// ---------------------------------------------------------------- pass-through
test('parseDirectives leaves a plain query untouched', () => {
    const src = 'not done\ndue today\nsort by priority';
    const r = parseDirectives(src);
    assert.equal(r.query, src);
    assert.equal(r.depth, null);
    assert.equal(r.showDescendants, null);
    assert.deepEqual(r.errors, []);
});

test('parseDirectives preserves the original text of kept lines', () => {
    // Lowercasing happens only for matching - Tasks filters can be case- and
    // whitespace-sensitive (paths, headings, tags).
    const src = 'path includes 0. Note/Project/Q3 Plan.md\nfilename does not include Daily';
    assert.equal(parseDirectives(src).query, src);
});

test('parseDirectives keeps a line that merely mentions a keyword', () => {
    const src = 'description includes show ancestors of the plan';
    assert.equal(parseDirectives(src).query, src);
});

test('parseDirectives handles an empty or missing source', () => {
    assert.equal(parseDirectives('').query, '');
    assert.equal(parseDirectives(null).query, '');
    assert.equal(parseDirectives(undefined).depth, null);
});

// ---------------------------------------------------------------- depth
test('parseDirectives reads ancestors depth', () => {
    const r = parseDirectives('not done\nancestors depth 2');
    assert.equal(r.depth, 2);
    assert.equal(r.query, 'not done');
});

test('parseDirectives accepts depth 0', () => {
    assert.equal(parseDirectives('ancestors depth 0').depth, 0);
});

test('parseDirectives clamps depth to the recursion limit', () => {
    assert.equal(parseDirectives('ancestors depth 999').depth, 20);
});

test('parseDirectives reports a non-numeric depth instead of ignoring it', () => {
    const r = parseDirectives('ancestors depth two');
    assert.equal(r.depth, null);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /ancestors depth/);
    assert.equal(r.query, '');   // consumed, not forwarded to Tasks
});

test('parseDirectives reports an unknown ancestors directive', () => {
    const r = parseDirectives('ancestors foo');
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /ancestors depth N/);
});

// ---------------------------------------------------------------- show / hide
test('parseDirectives maps hide ancestors to depth 0', () => {
    assert.equal(parseDirectives('hide ancestors').depth, 0);
});

test('parseDirectives maps show ancestors back to unlimited', () => {
    // Later lines win, so a block can undo an earlier directive.
    assert.equal(parseDirectives('hide ancestors\nshow ancestors').depth, null);
});

test('parseDirectives toggles descendants', () => {
    assert.equal(parseDirectives('hide descendants').showDescendants, false);
    assert.equal(parseDirectives('show descendants').showDescendants, true);
});

test('parseDirectives drops show/hide tree', () => {
    // Tasks would nest the <li>s itself and break our matching.
    const r = parseDirectives('not done\nshow tree');
    assert.equal(r.query, 'not done');
    assert.deepEqual(r.errors, []);
});

test('parseDirectives matches directives case-insensitively and trims them', () => {
    const r = parseDirectives('   HIDE   Ancestors   \n  Ancestors  Depth  3  ');
    assert.equal(r.depth, 3);
    assert.equal(r.query, '');
});

test('parseDirectives collects several directives from one block', () => {
    const r = parseDirectives('not done\nancestors depth 1\nhide descendants\nsort by due');
    assert.equal(r.depth, 1);
    assert.equal(r.showDescendants, false);
    assert.equal(r.query, 'not done\nsort by due');
});

// ---------------------------------------------------------------- trimChain
// chain runs root -> ... -> matched task, so depth counts from the tail.
const CHAIN = ['root', 'mid', 'parent', 'task'];

test('trimChain keeps everything when depth is unset', () => {
    assert.deepEqual(trimChain(CHAIN, null), CHAIN);
    assert.deepEqual(trimChain(CHAIN, undefined), CHAIN);
});

test('trimChain keeps the match plus N ancestors', () => {
    assert.deepEqual(trimChain(CHAIN, 0), ['task']);
    assert.deepEqual(trimChain(CHAIN, 1), ['parent', 'task']);
    assert.deepEqual(trimChain(CHAIN, 2), ['mid', 'parent', 'task']);
});

test('trimChain leaves a short chain alone', () => {
    assert.deepEqual(trimChain(CHAIN, 10), CHAIN);
    assert.deepEqual(trimChain(['task'], 3), ['task']);
});
