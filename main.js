'use strict';

/*
 * Tasks Ancestor View
 * -------------------
 * Companion plugin for Obsidian Tasks.
 *
 * Strategy:
 *   1. Tasks plugin renders FLAT query results (100% DSL compatible).
 *   2. We match each rendered <li> to a Task object via getTasks()
 *      (id first, then text heuristic + backlink filename/heading).
 *   3. Walk up each matched Task's .parent chain to collect ancestors.
 *   4. Restructure the flat DOM into an ancestor tree by MOVING the
 *      original <li> elements (preserves all event handlers).
 *   5. Ancestor items are created as new <li> with Obsidian markdown rendering.
 *
 * Keep VERSION in sync with manifest.json / versions.json - the release
 * workflow fails the build when the git tag and manifest disagree.
 */

var VERSION = '2.10.2';

// Deepest ancestor chain / descendant recursion we will follow.
var MAX_DEPTH = 20;

// How many candidate tasks a single rendered <li> carries into the global
// assignment. Anything past the best few has never won a row, and keeping the
// list short is what stops a vault-sized index from dominating a render pass.
var MAX_CANDIDATES = 5;

var DEFAULT_SETTINGS = {
    // Tasks re-renders in bursts; we wait for the burst to settle before
    // rebuilding the tree. Too low rebuilds mid-render, too high visibly lags.
    debounceMs: 400,
    // Expand what lives *under* a matched task too (plain checkboxes and list
    // items that are not #task). Off = ancestor chain only.
    showDescendants: true,
    // Clicking an ancestor's label opens its source line.
    clickToOpen: true,
    // When that click has to open a NEW tab and the workspace is split, put
    // the tab in the other split instead of on top of the query you clicked
    // from. Off = always the current tab group, as before.
    openInOtherSplit: true,
    // Per-pass console logging.
    debug: false,
};

// Mirrors settings.debug for the module-level log(). The plugin is a single
// instance, so a module-level flag beats threading settings through every call.
var debugFlag = false;

// require() is wrapped so this file can also be loaded by `node --test`,
// where the 'obsidian' module does not exist. Only the pure helpers at the
// top of the file are exercised there; the plugin classes are never
// instantiated outside Obsidian.
var obsidian = (function () {
    try { return require('obsidian'); } catch (e) { return {}; }
})();

// --- logging --------------------------------------------------------
// Rendering happens on every Tasks re-render, so per-pass logs are opt-in.
// Two ways in: the setting, or localStorage on a device with no settings UI
// handy (`localStorage.setItem('tav-debug', '1')` in the developer console).
function debugEnabled() {
    if (debugFlag) return true;
    try {
        return typeof localStorage !== 'undefined' && !!localStorage.getItem('tav-debug');
    } catch (e) {
        return false;
    }
}

function log(msg) {
    if (debugEnabled()) console.log('Tasks Ancestor View v' + VERSION + ': ' + msg);
}

// --- pure helpers (unit-tested via exports._internals) ---------------
function stripCheckbox(md) {
    // "  * [x] description" -> "description"
    // "  - description"     -> "description"  (plain list item, no checkbox)
    return (md || '')
        .replace(/^\s*[-*]\s*\[.\]\s*/, '')   // task checkbox
        .replace(/^\s*[-*]\s+/, '')            // plain list marker
        .replace(/^\s*\d+[.)]\s+/, '')         // numbered list marker
        .replace(/\s*\^[\w-]+$/, '')           // block anchor
        .trim();
}

function normalizeWS(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
}

// Reduce markdown source to the text Obsidian actually renders.
// The rendered DOM shows only a link's label, so comparing raw source
// against textContent fails for any task whose description contains a
// link or emphasis - such a task ends up unmatched, which makes it appear
// twice (once appended at the end of the list, once as another match's
// grey ancestor).
//
// Emphasis is stripped in PAIRS, never as bare characters. A blanket
// `[*_~`]` removal only touches this side of the comparison, so a
// description containing snake_case or a lone asterisk reduced to
// "snakecase" while the DOM still said "snake_case" - the very mismatch
// this function exists to prevent. Underscore pairs additionally require a
// non-word boundary, because Obsidian (CommonMark) does not emphasise
// intra-word underscores either.
function plainify(s) {
    return (s || '')
        .replace(/!?\[\[([^\]|]+)\|([^\]]*)\]\]/g, '$2')   // [[note|alias]] -> alias
        .replace(/!?\[\[([^\]]+)\]\]/g, '$1')              // [[note]]       -> note
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')         // [label](url)   -> label
        .replace(/%%[\s\S]*?%%/g, '')                      // %%comment%%    -> not rendered at all
        .replace(/==([^=]+)==/g, '$1')                     // ==highlight==  -> highlight
        .replace(/~~([^~]+)~~/g, '$1')                     // ~~strike~~
        .replace(/\*\*([^*]+)\*\*/g, '$1')                 // **bold**
        .replace(/\*([^*]+)\*/g, '$1')                     // *em*
        .replace(/`([^`]+)`/g, '$1')                       // `code`
        .replace(/(^|[^\w])__([^_]+)__(?![\w])/g, '$1$2')  // __bold__ (word boundaries only)
        .replace(/(^|[^\w])_([^_]+)_(?![\w])/g, '$1$2')    // _em_     (word boundaries only)
        .replace(/<[^>]+>/g, '');                          // inline HTML
}

// Tasks' emoji metadata fields (tasksPluginEmoji format), each with the class
// name Tasks itself uses so a theme or CSS snippet styles ours identically.
//
// `show` decides what earns a place on an ancestor row. An ancestor is context:
// dates, priority and recurrence help you place it, while the id / created /
// dependsOn / onCompletion fields are bookkeeping that only adds noise there.
// Written as escapes to keep this file ASCII - these are non-BMP characters and
// tooling has mangled them before.
var META_FIELDS = [
    { sym: '\u{1F53A}', cls: 'task-priority', show: true },     // highest
    { sym: '\u{23EB}', cls: 'task-priority', show: true },      // high
    { sym: '\u{1F53C}', cls: 'task-priority', show: true },     // medium
    { sym: '\u{1F53D}', cls: 'task-priority', show: true },     // low
    { sym: '\u{23EC}', cls: 'task-priority', show: true },      // lowest
    { sym: '\u{1F501}', cls: 'task-recurring', show: true },    // recurrence
    { sym: '\u{1F6EB}', cls: 'task-start', show: true },        // start
    { sym: '\u{23F3}', cls: 'task-scheduled', show: true },     // scheduled
    { sym: '\u{1F4C5}', cls: 'task-due', show: true },          // due
    { sym: '\u{2705}', cls: 'task-done', show: true },          // done
    { sym: '\u{274C}', cls: 'task-cancelled', show: true },     // cancelled
    { sym: '\u{2795}', cls: 'task-created', show: false },      // created
    { sym: '\u{1F194}', cls: 'task-id', show: false },          // id
    { sym: '\u{26D4}', cls: 'task-dependency', show: false },   // dependsOn
    { sym: '\u{1F3C1}', cls: 'task-onCompletion', show: false } // onCompletion
];

// Split a task line into its description and its metadata fields.
//
// Scanned with indexOf rather than one big regex: these symbols are non-BMP and
// a character class built from them silently matches surrogate halves instead.
// Each field runs from its own symbol to the next one, so values containing
// spaces ("every day") survive intact.
function splitMetadata(text) {
    var s = text || '';
    var hits = [];
    for (var i = 0; i < META_FIELDS.length; i++) {
        var f = META_FIELDS[i];
        var at = s.indexOf(f.sym);
        while (at !== -1) {
            hits.push({ at: at, field: f });
            at = s.indexOf(f.sym, at + f.sym.length);
        }
    }
    if (!hits.length) return { text: s.trim(), fields: [] };

    hits.sort(function (a, b) { return a.at - b.at; });

    var fields = [];
    for (var h = 0; h < hits.length; h++) {
        var start = hits[h].at + hits[h].field.sym.length;
        var end = h + 1 < hits.length ? hits[h + 1].at : s.length;
        fields.push({
            cls: hits[h].field.cls,
            show: hits[h].field.show,
            symbol: hits[h].field.sym,
            value: s.slice(start, end).trim()
        });
    }
    return { text: s.slice(0, hits[0].at).trim(), fields: fields };
}

// Stable identity for a Task / ListItem so two different JS objects pointing
// to the same source line merge in the ancestor tree. Tasks plugin can re-parse
// and produce a fresh object for the same line; without this, the leaf's
// matched task and its own .parent chain may not share references, causing
// the same ancestor to render twice (once as ancestor, once as matched leaf).
function itemKey(item) {
    if (!item) return '';
    // 1) Tasks-plugin id emoji - user-assigned, globally unique per source line.
    //    This is the strongest identity signal and survives re-parses where
    //    taskLocation may diverge between cached and live objects.
    var id = (item.id || '').toString().trim();
    if (id) return 'id:' + id;
    // 2) Source location.
    var loc = item.taskLocation || item._taskLocation || null;
    var path = (loc && (loc.path || loc._path)) || item.path || item.filename || '';
    var line = (loc && (loc.lineNumber != null ? loc.lineNumber : loc._lineNumber));
    if (line == null) line = item.lineNumber;
    if (line == null) line = item._lineNumber;
    if (path && line != null) return 'loc:' + path + ':' + line;
    // 3) Last-resort fallback - collapses items with identical text in same
    //    file, which is acceptable since they would render identically anyway.
    return 'md:' + (item.originalMarkdown || '').trim() + '|' + path;
}

// The file a leaf is showing.
//
// A background tab can be *deferred* (Obsidian 1.7.2+): the leaf still reports
// type markdown, but its view is a DeferredView, so `view.file` is undefined.
// The view state carries the path in both states, so read that first.
function leafFilePath(leaf) {
    if (!leaf) return '';
    if (typeof leaf.getViewState === 'function') {
        var st = leaf.getViewState();
        var f = st && st.state && st.state.file;
        if (typeof f === 'string' && f) return f;
    }
    var view = leaf.view;
    return (view && view.file && view.file.path) || '';
}

// The tab already showing `path` in the main workspace, or null.
//
// Sidebars and pop-out windows are deliberately excluded: a click that throws
// focus to another window is more surprising than a second tab.
//
// Recency is best effort. Obsidian only exposes "the most recent leaf" overall
// (a per-leaf timestamp is not public API), so when that leaf is not one of our
// matches - the usual case, since the note you clicked *from* is the recent one
// - we fall back to the first match in tab order.
function allLeaves(workspace) {
    // iterateAllLeaves first: getLeavesOfType() filters on the *loaded* view
    // type, so a deferred background tab can be missing from it entirely.
    if (typeof workspace.iterateAllLeaves === 'function') {
        var out = [];
        workspace.iterateAllLeaves(function (leaf) { out.push(leaf); });
        return out;
    }
    if (typeof workspace.getLeavesOfType === 'function') {
        return workspace.getLeavesOfType('markdown') || [];
    }
    return [];
}

function findOpenLeaf(workspace, path) {
    if (!workspace) return null;

    var root = workspace.rootSplit;
    var leaves = allLeaves(workspace);
    var matches = [];
    var offRoot = 0;
    for (var i = 0; i < leaves.length; i++) {
        var leaf = leaves[i];
        if (leafFilePath(leaf) !== path) continue;
        // No getRoot (older API) -> do not exclude. An extra tab is a smaller
        // failure than never matching at all.
        if (root && typeof leaf.getRoot === 'function' && leaf.getRoot() !== root) {
            offRoot++;
            continue;
        }
        matches.push(leaf);
    }
    log('findOpenLeaf: ' + leaves.length + ' leaf/leaves scanned, ' + matches.length +
        ' match(es)' + (offRoot ? ', ' + offRoot + ' outside main workspace' : '') +
        ' for ' + path);
    if (!matches.length) return null;

    var recent = typeof workspace.getMostRecentLeaf === 'function'
        ? workspace.getMostRecentLeaf(root)
        : null;
    return recent && matches.indexOf(recent) !== -1 ? recent : matches[0];
}

// The leaf our own code block is rendered inside.
//
// Found by DOM containment rather than by asking the workspace what is active:
// a click can arrive while focus sits somewhere else entirely, and "the tab I
// clicked from" is the only thing that makes "the OTHER split" meaningful.
function findHostLeaf(leaves, el) {
    if (!el) return null;
    for (var i = 0; i < leaves.length; i++) {
        var container = leaves[i] && leaves[i].containerEl;
        if (container && typeof container.contains === 'function' && container.contains(el)) {
            return leaves[i];
        }
    }
    return null;
}

// The first tab group in layout order that is NOT the one hostLeaf sits in,
// or null when the workspace is not split.
//
// leaf.parent is the tab group (WorkspaceTabs on desktop) and is public API
// only from Obsidian 1.6.6, while our minAppVersion is older - a missing
// parent simply means "no other group", and the caller falls back.
function findOtherGroup(leaves, hostLeaf, root) {
    var home = hostLeaf && hostLeaf.parent;
    if (!home) return null;
    for (var i = 0; i < leaves.length; i++) {
        var leaf = leaves[i];
        var group = leaf && leaf.parent;
        if (!group || group === home) continue;
        // Same exclusion as findOpenLeaf: sidebars and pop-out windows are not
        // "the other half of the screen".
        if (root && typeof leaf.getRoot === 'function' && leaf.getRoot() !== root) continue;
        return group;
    }
    return null;
}

// Split a code block's body into the directives this plugin owns and the
// query that goes to Tasks untouched.
//
// Returns { query, depth, showDescendants, errors }
//   depth            max ancestor levels above a match; null = unlimited
//   showDescendants  true / false, or null to follow the setting
//
// Only lines we actually recognise are consumed. Anything else is Tasks' DSL
// and must reach it verbatim - guessing here would silently drop a filter.
function parseDirectives(source) {
    var out = { query: '', depth: null, showDescendants: null, errors: [] };
    var kept = [];
    var lines = (source || '').split('\n');

    for (var i = 0; i < lines.length; i++) {
        var raw = lines[i];
        var line = raw.trim().toLowerCase();

        // Tasks' own tree option nests the <li>s, which breaks our matching -
        // we build the tree ourselves, so it is dropped rather than forwarded.
        if (/^(show|hide)[ ]+tree$/.test(line)) continue;

        if (/^show[ ]+ancestors$/.test(line)) { out.depth = null; continue; }
        if (/^hide[ ]+ancestors$/.test(line)) { out.depth = 0; continue; }
        if (/^show[ ]+descendants$/.test(line)) { out.showDescendants = true; continue; }
        if (/^hide[ ]+descendants$/.test(line)) { out.showDescendants = false; continue; }

        var m = /^ancestors[ ]+depth[ ]+(.+)$/.exec(line);
        if (m) {
            var arg = m[1].trim();
            if (/^[0-9]+$/.test(arg)) out.depth = Math.min(parseInt(arg, 10), MAX_DEPTH);
            else out.errors.push('ancestors depth 뒤에는 0 이상의 정수가 와야 합니다: "' + raw.trim() + '"');
            continue;
        }

        // Starts like ours but is not one of ours - say so instead of handing
        // Tasks a line it will reject with a less useful message.
        if (/^ancestors\b/.test(line)) {
            out.errors.push('알 수 없는 지시어: "' + raw.trim() + '" (사용법: ancestors depth N)');
            continue;
        }

        kept.push(raw);
    }

    out.query = kept.join('\n').trim();
    return out;
}

// Cut an ancestor chain (root -> ... -> matched task) down to the matched task
// plus `depth` levels above it. null/undefined keeps the whole chain.
function trimChain(chain, depth) {
    if (depth === null || depth === undefined) return chain;
    var keep = depth + 1;
    return chain.length > keep ? chain.slice(chain.length - keep) : chain;
}
// Keep the debounce usable. data.json is hand-editable and a stray value
// (0, "", "abc") would either spin or freeze the view.
function clampDebounce(value, fallback) {
    var n = typeof value === 'number' ? value : parseInt(value, 10);
    if (!isFinite(n)) return fallback;
    return Math.min(5000, Math.max(50, Math.round(n)));
}

// Saved settings merged onto the defaults and coerced. A missing key means
// "default"; the booleans default to on, so only an explicit false turns them off.
function mergeSettings(saved) {
    var s = Object.assign({}, DEFAULT_SETTINGS, saved || {});
    s.debounceMs = clampDebounce(s.debounceMs, DEFAULT_SETTINGS.debounceMs);
    s.showDescendants = s.showDescendants !== false;
    s.clickToOpen = s.clickToOpen !== false;
    s.openInOtherSplit = s.openInOtherSplit !== false;
    s.debug = !!s.debug;
    return s;
}

// Source location of a Task / ListItem, or null when it cannot be determined.
// Same field fallbacks as itemKey() - Tasks exposes taskLocation on live objects
// and _taskLocation on some cached ones.
function itemLocation(item) {
    if (!item) return null;
    var loc = item.taskLocation || item._taskLocation || null;
    var path = (loc && (loc.path || loc._path)) || item.path || '';
    var line = loc && (loc.lineNumber != null ? loc.lineNumber : loc._lineNumber);
    if (line == null) line = item.lineNumber;
    if (line == null) line = item._lineNumber;
    if (!path || line == null || line < 0) return null;
    return { path: path, line: line };
}

// Where the item's source line lives *now*. The recorded line number is from
// whenever Tasks last parsed the file, so an edit above it shifts the target.
// Tasks' own backlink resolves this the same way: trust the recorded line while
// it still holds the original markdown, else look for a unique match.
// Ambiguous (several identical lines) or missing -> keep the recorded line.
function resolveLine(lines, originalMarkdown, hintLine) {
    if (!originalMarkdown) return hintLine;
    if (lines[hintLine] === originalMarkdown) return hintLine;
    var found = -1;
    for (var i = 0; i < lines.length; i++) {
        if (lines[i] !== originalMarkdown) continue;
        if (found !== -1) return hintLine;   // 여러 줄이 동일 -> 고르지 않는다
        found = i;
    }
    return found === -1 ? hintLine : found;
}

// Backlink text is rendered as "filename > heading" (Tasks getLinkText()).
// Used only as a tiebreak - never as a primary match signal.
function backlinkBonus(entry, backlinkText) {
    if (!backlinkText) return 0;
    var bonus = 0;
    if (entry.filename && backlinkText.indexOf(entry.filename) !== -1) bonus += 25;
    if (entry.heading && backlinkText.indexOf(entry.heading) !== -1) bonus += 10;
    return bonus;
}

// How much of `whole` the substring `part` accounts for, 0..1. Used to tell a
// strong match from a coincidental one: a two-word description "hits" almost
// any rendered line, and without this weighting it scored exactly as high as
// the task that actually owned the row.
function coverage(part, whole) {
    if (!part || !whole) return 0;
    var r = part.length / whole.length;
    return r > 1 ? 1 : r;
}

// Score one index entry against a rendered <li>. Returns 0 for "no match".
//
// Bands, strongest first:
//   100      description equals the rendered text
//   85 - 95  rendered text starts with the description - the normal case,
//            since Tasks appends metadata spans after it
//   70       originalMarkdown equals the rendered text (legacy fallback)
//   60 - 80  description appears somewhere inside
//   30 - 50  remaining originalMarkdown fallbacks
//
// Within a band, longer coverage wins. That is what keeps a short description
// from stealing a longer task's row: both may be a prefix of the same rendered
// text, but only one of them accounts for most of it.
function scoreEntry(entry, renderedText, backlinkText) {
    var score = 0;

    // 1) Description-based match: strongest signal. The rendered
    //    .tasks-list-text always begins with the description, then
    //    appends metadata spans, so renderedText should contain desc.
    if (entry.desc) {
        if (renderedText === entry.desc) {
            score = 100;
        } else if (renderedText.indexOf(entry.desc) === 0) {
            score = 85 + Math.round(10 * coverage(entry.desc, renderedText));
        } else if (renderedText.indexOf(entry.desc) !== -1) {
            score = 60 + Math.round(20 * coverage(entry.desc, renderedText));
        }
    }

    // 2) Fallback: full-line match against originalMarkdown (legacy path).
    if (score === 0 && entry.stripped) {
        if (entry.stripped === renderedText) {
            score = 70;
        } else if (entry.stripped.indexOf(renderedText) !== -1) {
            score = 40 + Math.round(10 * coverage(renderedText, entry.stripped));
        } else if (renderedText.indexOf(entry.stripped) !== -1) {
            score = 30 + Math.round(10 * coverage(entry.stripped, renderedText));
        }
    }

    if (score === 0) return 0;
    return score + backlinkBonus(entry, backlinkText);
}

// Precompute every string comparison input once per Tasks re-parse (see
// TasksAncestorPlugin.getIndex). Without this, matching is O(rendered <li> x
// all vault tasks) with several regex passes per comparison - and the cost
// multiplies by the number of group <ul>s a query produces.
function buildIndex(allTasks) {
    var byId = new Map();
    var entries = [];

    for (var i = 0; i < allTasks.length; i++) {
        var t = allTasks[i];
        var entry = {
            task: t,
            id: (t.id || '').toString().trim(),
            desc: normalizeWS(plainify(t.description || '')),
            stripped: normalizeWS(plainify(stripCheckbox(t.originalMarkdown || ''))),
            filename: t.filename || '',
            heading: t.precedingHeader || ''
        };
        if (!entry.desc && !entry.stripped) continue;

        entries.push(entry);

        if (entry.id) {
            if (!byId.has(entry.id)) byId.set(entry.id, []);
            byId.get(entry.id).push(entry);
        }
    }

    return { byId: byId, entries: entries };
}

// --- matching -------------------------------------------------------
// An id exact match is definitive. Multiple source lines can carry the same
// id (gcal-sync assigns them automatically), so tiebreak on backlink.
function pickById(index, item, usedTasks) {
    var candidates = index.byId.get(item.id);
    if (!candidates) return null;

    var best = null;
    var bestBonus = -1;
    for (var i = 0; i < candidates.length; i++) {
        var entry = candidates[i];
        if (usedTasks.has(entry.task)) continue;
        var bonus = backlinkBonus(entry, item.backlink);
        if (bonus > bestBonus) { bestBonus = bonus; best = entry; }
    }
    return best;
}

// Deterministic ordering for candidate pairs: best score, then the more
// specific (longer) description, then source order. Nothing is left to sort
// stability - the same list must produce the same tree on every pass.
function comparePairs(a, b) {
    if (b.score !== a.score) return b.score - a.score;
    var la = (a.entry.desc || '').length;
    var lb = (b.entry.desc || '').length;
    if (lb !== la) return lb - la;
    if (a.item !== b.item) return a.item - b.item;
    return a.order - b.order;
}

// Assign rendered <li> items to index entries.
//
// `pending` items are {li, text, backlink, id}. The li is opaque here, which
// is what lets the whole assignment run under node --test on plain objects.
//
// Two passes, because the two signals are not the same kind of evidence:
//   1. An id is definitive - those items claim their task outright, before a
//      text heuristic can spend it on somebody else.
//   2. Everything else is assigned GLOBALLY, best score first, instead of in
//      DOM order. The old per-item greedy walk let whichever li came first
//      take a task that a later, better-scoring li owned outright.
//
// Returns {matches, unmatched}, both in the caller's original order, so the
// rendered tree keeps the sort order Tasks produced.
function matchItems(index, pending) {
    var assigned = new Map();     // index into pending -> index entry
    var usedTasks = new Set();
    var leftovers = [];

    for (var p = 0; p < pending.length; p++) {
        if (!pending[p].id) { leftovers.push(p); continue; }
        var picked = pickById(index, pending[p], usedTasks);
        if (picked) {
            assigned.set(p, picked);
            usedTasks.add(picked.task);
        } else {
            leftovers.push(p);    // unknown id -> fall back to text matching
        }
    }

    // Collect plausible pairs, capped per item so a vault-sized index cannot
    // turn the sort below into the expensive part of a render pass.
    var pairs = [];
    for (var l = 0; l < leftovers.length; l++) {
        var idx = leftovers[l];
        var item = pending[idx];
        var candidates = [];
        for (var e = 0; e < index.entries.length; e++) {
            var entry = index.entries[e];
            if (usedTasks.has(entry.task)) continue;
            // Hard disambiguation: if both the rendered li and the task carry
            // an id, a mismatch is a definitive non-match.
            if (item.id && entry.id && item.id !== entry.id) continue;
            var score = scoreEntry(entry, item.text, item.backlink);
            if (score <= 0) continue;
            candidates.push({ item: idx, entry: entry, order: e, score: score });
        }
        candidates.sort(comparePairs);
        for (var k = 0; k < candidates.length && k < MAX_CANDIDATES; k++) pairs.push(candidates[k]);
    }

    pairs.sort(comparePairs);
    for (var i = 0; i < pairs.length; i++) {
        var pair = pairs[i];
        if (assigned.has(pair.item) || usedTasks.has(pair.entry.task)) continue;
        assigned.set(pair.item, pair.entry);
        usedTasks.add(pair.entry.task);
    }

    var matches = [];
    var unmatched = [];
    for (var q = 0; q < pending.length; q++) {
        var hit = assigned.get(q);
        if (hit) matches.push({ item: pending[q], entry: hit });
        else unmatched.push(pending[q]);
    }
    return { matches: matches, unmatched: unmatched };
}

// --- tree building --------------------------------------------------
function newNode(item) {
    return { item: item, children: [], matchedLi: null, _childMap: new Map() };
}

// Find or create the child node for an item. Keyed by source-location identity
// so a matched leaf and an ancestor referring to the same source line collapse
// to a single node even when Tasks hands us two different JS objects for them.
function childFor(node, item) {
    var key = itemKey(item);
    if (!node._childMap.has(key)) {
        var created = newNode(item);
        node.children.push(created);
        node._childMap.set(key, created);
    }
    return node._childMap.get(key);
}

// Tasks has shipped children as an array, a Map and a plain object across
// versions - normalise before walking.
function childList(ch) {
    var kids = [];
    if (!ch) return kids;
    if (ch instanceof Map) { ch.forEach(function (v) { kids.push(v); }); return kids; }
    if (Array.isArray(ch)) return ch.slice();
    if (typeof ch.forEach === 'function') { ch.forEach(function (v) { kids.push(v); }); return kids; }
    if (typeof ch === 'object') {
        for (var k in ch) if (Object.prototype.hasOwnProperty.call(ch, k)) kids.push(ch[k]);
    }
    return kids;
}

// Attach what lives under a matched task - plain checkboxes (without the
// global filter) and plain list items. itemKey-based merging means a
// descendant that is itself a matched leaf collapses onto its existing node.
function attachDescendants(parentNode, item, depth, seen) {
    if (!item || depth >= MAX_DEPTH) return;
    if (!item.children) return;

    // Guard against a malformed parent/child cycle in the Tasks cache - one
    // bad edge would otherwise recurse until the stack blows.
    var selfKey = itemKey(item);
    if (seen.has(selfKey)) return;
    seen.add(selfKey);

    var kids = childList(item.children);
    for (var i = 0; i < kids.length; i++) {
        attachDescendants(childFor(parentNode, kids[i]), kids[i], depth + 1, seen);
    }
}

// Build a virtual tree from matched tasks by walking up each task's parent
// chain. Shared ancestors are merged.
//
// matches are {li, task}; li is carried through untouched. Options:
//   depth        max ancestor levels above a match; null = unlimited
//   descendants  also expand what lives under a matched task
//
// Returns a virtual root node { item:null, children:[], matchedLi:null }; each
// child is { item:ListItem|Task, children:[], matchedLi:li|null }.
function buildTree(matches, opts) {
    var depth = opts && opts.depth != null ? opts.depth : null;
    var wantDescendants = !!(opts && opts.descendants);
    var root = newNode(null);

    for (var i = 0; i < matches.length; i++) {
        var task = matches[i].task;

        // Ancestor chain, root first.
        var chain = [];
        var cur = task;
        var guard = 0;
        while (cur && guard++ < MAX_DEPTH) {
            chain.unshift(cur);
            cur = cur.parent;
        }
        chain = trimChain(chain, depth);

        var node = root;
        for (var c = 0; c < chain.length; c++) node = childFor(node, chain[c]);

        // The leaf node corresponds to the matching task.
        node.matchedLi = matches[i].li;

        if (wantDescendants) attachDescendants(node, task, 0, new Set());
    }

    return root;
}

// --- DOM helpers ----------------------------------------------------
// Return the first match that belongs to `li` ITSELF. A plain
// li.querySelector() also descends into the nested <ul> we insert under a
// matched task, so on a re-render pass a parent would read its child's
// id / text / backlink and mis-match (or reject) itself.
function ownQuery(li, sel) {
    var found = li.querySelectorAll(sel);
    for (var i = 0; i < found.length; i++) {
        var p = found[i].parentElement;
        var own = true;
        while (p && p !== li) {
            if (p.tagName === 'UL' || p.tagName === 'OL') { own = false; break; }
            p = p.parentElement;
        }
        if (own) return found[i];
    }
    return null;
}

// The element that actually scrolls around a rendered block: the reading view
// scrolls .markdown-preview-view, the editor scrolls .cm-scroller. The walk-up
// fallback keeps this working if Obsidian renames either one - a wrong-but-
// scrollable ancestor still beats giving up.
function findScroller(el) {
    if (!el) return null;
    if (typeof el.closest === 'function') {
        var known = el.closest('.markdown-preview-view, .cm-scroller');
        if (known) return known;
    }
    var node = el.parentElement;
    while (node) {
        if (node.scrollHeight - node.clientHeight > 1) return node;
        node = node.parentElement;
    }
    return null;
}

// Click, middle click and keyboard, all routed through the same open().
//
// Enter/Space are what a keyboard user expects from role="link"; without them
// the labels are the only unreachable thing in an otherwise navigable query
// result, and there is no other way to follow an ancestor to its source.
//
// onMouseDown fires only for the mouse, and before anything can move: it is
// where the caller records where the list was, for _restoreScroll. Keyboard
// opens deliberately do not record - tabbing to an off-screen row is supposed
// to scroll it into view.
function wireOpenGestures(el, open, onMouseDown) {
    // A mouse click must not scroll. The label is focusable for the keyboard's
    // sake, and the browser scrolls a freshly focused element into view when it
    // is only partly visible - which yanks the very list you clicked from, but
    // only for rows near the edge, so it reads as random.
    //
    // Taking the focus ourselves with preventScroll leaves the browser's own
    // focus step nothing to do. preventDefault() here would also stop the
    // scroll, but it kills drag-selecting the text as well. Focus from the
    // keyboard still scrolls, which is the whole point of tabbing to a row.
    el.addEventListener('mousedown', function (evt) {
        if (evt.target && evt.target.closest && evt.target.closest('a')) return;
        if (typeof el.focus === 'function') el.focus({ preventScroll: true });
        if (onMouseDown) onMouseDown(el);
    });
    el.addEventListener('click', function (evt) { open(evt, false); });
    el.addEventListener('auxclick', function (evt) {
        if (evt.button === 1) open(evt, true);
    });
    el.addEventListener('keydown', function (evt) {
        if (evt.key !== 'Enter' && evt.key !== ' ') return;
        open(evt, false);
    });
}

// Remove any nested <ul> children from an <li> - prevents accumulating
// stale descendant lists across re-render passes.
function stripNestedUls(li) {
    var uls = [];
    for (var i = 0; i < li.children.length; i++) {
        if (li.children[i].tagName === 'UL') uls.push(li.children[i]);
    }
    for (var j = 0; j < uls.length; j++) li.removeChild(uls[j]);
}

// Undo our own tree, back to the flat list Tasks rendered.
//
// Our ancestor <li>s hold the matched <li>s inside a nested <ul>. Deleting the
// ancestors alone would take those matches down with them and leave an empty
// list until Tasks re-renders. So lift every <li> that is NOT ours back to the
// top level, in document order, and drop the rest.
function flattenOurTree(ul) {
    if (!ul.querySelector('li[data-tav="ancestor"]')) return;

    var all = ul.querySelectorAll('li');
    var keep = [];
    for (var i = 0; i < all.length; i++) {
        if (all[i].getAttribute('data-tav') !== 'ancestor') keep.push(all[i]);
    }
    // Collected before any detaching, so removing a parent cannot lose a child.
    for (var k = 0; k < keep.length; k++) stripNestedUls(keep[k]);
    while (ul.firstChild) ul.removeChild(ul.firstChild);
    for (var j = 0; j < keep.length; j++) ul.appendChild(keep[j]);
}

// Cheap fingerprint of a <ul>'s direct children, used to skip re-processing
// a list we already restructured and nobody has touched since.
function ulSignature(ul) {
    var parts = [];
    for (var i = 0; i < ul.children.length; i++) {
        var el = ul.children[i];
        if (el.tagName !== 'LI') continue;
        var labelEl = ownQuery(el, '.tasks-list-text') || ownQuery(el, '.tasks-ancestor-label');
        parts.push(
            (el.getAttribute('data-tav') || '-') + '|' +
            normalizeWS(labelEl ? labelEl.textContent : '') + '|' +
            el.children.length
        );
    }
    return parts.join(' // ');
}

// --- Plugin ---------------------------------------------------------
var TasksAncestorPlugin = (function (_super) {
    TasksAncestorPlugin.prototype = Object.create(_super.prototype);
    TasksAncestorPlugin.prototype.constructor = TasksAncestorPlugin;
    function TasksAncestorPlugin() { return _super.apply(this, arguments) || this; }

    TasksAncestorPlugin.prototype.onload = async function () {
        var plugin = this;
        // Live render children, so a settings change can redraw open notes
        // instead of asking the user to reopen them.
        //
        // Deliberately NOT named _children: that is Obsidian's own Component
        // field (an array of child components). Shadowing it with a Set makes
        // unload() throw on _children.slice(), which takes the whole plugin
        // down when it is reloaded or updated.
        this._renderChildren = new Set();
        // { tasks, index } for the last getTasks() array we indexed.
        this._indexCache = null;

        await this.loadSettings();
        log('loaded');

        this.addSettingTab(new AncestorSettingTab(this.app, this));

        this.registerMarkdownCodeBlockProcessor('tasks-ancestors', function (source, el, ctx) {
            plugin.app.workspace.onLayoutReady(function () {
                var child = new AncestorRenderChild(plugin, el, source, ctx);
                ctx.addChild(child);
                child.load();
            });
        });
    };

    /**
     * The match index for a set of tasks, built at most once per Tasks re-parse.
     *
     * Every open block used to index the whole vault for itself on every pass -
     * a note with a Today block and a Done block paid for it twice. getTasks()
     * hands back the same array until Tasks re-parses, so array identity is a
     * safe cache key; a miss just rebuilds as before.
     */
    TasksAncestorPlugin.prototype.getIndex = function (allTasks) {
        var cache = this._indexCache;
        if (cache && cache.tasks === allTasks) {
            log('index cache hit (' + cache.index.entries.length + ' entries)');
            return cache.index;
        }
        var t0 = Date.now();
        var index = buildIndex(allTasks);
        log('index built: ' + index.entries.length + '/' + allTasks.length +
            ' tasks in ' + (Date.now() - t0) + 'ms');
        this._indexCache = { tasks: allTasks, index: index };
        return index;
    };

    TasksAncestorPlugin.prototype.onunload = function () {
        this._indexCache = null;
        log('unloaded');
    };

    TasksAncestorPlugin.prototype.loadSettings = async function () {
        this.settings = mergeSettings(await this.loadData());
        debugFlag = this.settings.debug;
    };

    TasksAncestorPlugin.prototype.saveSettings = async function () {
        debugFlag = this.settings.debug;
        await this.saveData(this.settings);
        this.refreshViews();
    };

    /** Redraw every open block. Clearing the signature defeats the skip check. */
    TasksAncestorPlugin.prototype.refreshViews = function () {
        if (!this._renderChildren) return;
        this._renderChildren.forEach(function (child) { child.forceReprocess(); });
    };

    TasksAncestorPlugin.prototype.trackChild = function (child) {
        if (this._renderChildren) this._renderChildren.add(child);
    };

    TasksAncestorPlugin.prototype.untrackChild = function (child) {
        if (this._renderChildren) this._renderChildren.delete(child);
    };

    return TasksAncestorPlugin;
}(obsidian.Plugin || function () {}));

// --- Render Child ---------------------------------------------------
var AncestorRenderChild = (function (_super) {
    AncestorRenderChild.prototype = Object.create(_super.prototype);
    AncestorRenderChild.prototype.constructor = AncestorRenderChild;

    function AncestorRenderChild(plugin, containerEl, source, ctx) {
        var _this = _super.call(this, containerEl) || this;
        _this._plugin = plugin;
        _this._app = plugin.app;
        _this._source = source;
        _this._ctx = ctx;
        // Replaced in onload(); the default keeps a child that bailed early
        // (no Tasks plugin) from throwing if anything reaches for it.
        _this._directives = { query: source, depth: null, showDescendants: null, errors: [] };
        _this._observer = null;
        _this._timeout = null;
        _this._processing = false;
        _this._unloaded = false;
        // A mutation that lands mid-pass has nothing to re-trigger it: the
        // observer is disconnected while we work. Remember it and go again.
        _this._dirty = false;
        // Where the clicked list was sitting when the mouse went down.
        _this._scrollAnchor = null;
        return _this;
    }

    // Read through to the plugin every time - settings can change while the
    // block is open, and the fallback keeps a detached child from throwing.
    AncestorRenderChild.prototype._settings = function () {
        return (this._plugin && this._plugin.settings) || DEFAULT_SETTINGS;
    };

    /** A block directive beats the global setting; null means "no opinion". */
    AncestorRenderChild.prototype._wantsDescendants = function () {
        var d = this._directives.showDescendants;
        return d === null || d === undefined ? this._settings().showDescendants : d;
    };

    /** Settings changed - rebuild now instead of waiting for a Tasks re-render. */
    AncestorRenderChild.prototype.forceReprocess = function () {
        if (this._unloaded || !this.containerEl) return;
        var uls = this.containerEl.querySelectorAll('ul.plugin-tasks-query-result');
        for (var i = 0; i < uls.length; i++) uls[i].removeAttribute('data-tav-sig');
        this._processResults();
    };

    // -- lifecycle ---------------------------------------------------
    AncestorRenderChild.prototype.onload = function () {
        var self = this;
        if (this._plugin) this._plugin.trackChild(this);

        var tasksPlugin = this._app.plugins && this._app.plugins.plugins &&
            this._app.plugins.plugins['obsidian-tasks-plugin'];

        if (!tasksPlugin) {
            this.containerEl.createEl('pre', {
                text: 'Tasks Ancestor View: "Tasks" plugin is not installed or not enabled.'
            });
            return;
        }

        // The two members below are internal-but-public Tasks API. Check them
        // explicitly so a Tasks update that renames them produces a readable
        // message instead of a silently blank block.
        var apiOk = typeof tasksPlugin.getTasks === 'function' &&
            tasksPlugin.queryRenderer &&
            typeof tasksPlugin.queryRenderer.addQueryRenderChild === 'function';

        if (!apiOk) {
            var tasksVersion = (tasksPlugin.manifest && tasksPlugin.manifest.version) || 'unknown';
            this.containerEl.createEl('pre', {
                text: 'Tasks Ancestor View: incompatible Tasks plugin API ' +
                    '(Tasks v' + tasksVersion + '). Expected getTasks() and ' +
                    'queryRenderer.addQueryRenderChild().'
            });
            return;
        }
        this._tasksPlugin = tasksPlugin;

        // Take out our own directives; the rest is Tasks' DSL, unchanged.
        var parsed = parseDirectives(this._source);
        this._directives = parsed;

        // A mistyped directive is silently ignored otherwise - the block just
        // renders "wrong" with no clue why.
        for (var e = 0; e < parsed.errors.length; e++) {
            this.containerEl.createEl('div', {
                text: 'Tasks Ancestor View: ' + parsed.errors[e],
                cls: 'tasks-ancestor-error',
            });
        }

        // Let the Tasks plugin render the flat query (100% DSL).
        log('requesting flat render (depth=' + parsed.depth +
            ', descendants=' + parsed.showDescendants + ')');
        tasksPlugin.queryRenderer.addQueryRenderChild(parsed.query, this.containerEl, this._ctx);

        // Watch for render completion / re-renders.
        this._observer = new MutationObserver(function () {
            clearTimeout(self._timeout);
            self._timeout = setTimeout(
                function () { self._processResults(); },
                self._settings().debounceMs
            );
        });
        this._observer.observe(this.containerEl, { childList: true, subtree: true, characterData: true });
    };

    AncestorRenderChild.prototype.onunload = function () {
        this._unloaded = true;
        if (this._plugin) this._plugin.untrackChild(this);
        if (this._observer) this._observer.disconnect();
        this._observer = null;
        clearTimeout(this._timeout);
    };

    // -- core --------------------------------------------------------
    AncestorRenderChild.prototype._processResults = function () {
        if (this._unloaded || !this._observer) return;
        if (this._processing) { this._dirty = true; return; }
        this._processing = true;
        this._dirty = false;
        this._observer.disconnect();

        var self = this;
        this._doProcess().catch(function (e) {
            console.error('Tasks Ancestor View v' + VERSION + ': processing error', e);
        }).finally(function () {
            // Reconnect after a tick so our own DOM writes don't retrigger.
            setTimeout(function () {
                // _doProcess awaits MarkdownRenderer, so the child can be
                // unloaded mid-flight - never reattach to a detached container.
                if (self._unloaded) return;
                if (self._observer && self.containerEl) {
                    self._observer.observe(self.containerEl, { childList: true, subtree: true, characterData: true });
                }
                self._processing = false;
                // Something changed while we were rebuilding. Cheap to redo -
                // the ulSignature check drops out early if it was our own write.
                if (self._dirty) self._processResults();
            }, 50);
        });
    };

    AncestorRenderChild.prototype._doProcess = async function () {
        var allTasks = this._tasksPlugin.getTasks();
        if (!allTasks || allTasks.length === 0) return;

        // Find every top-level <ul> (skip nested ones - those would be ours from a prior run).
        var topUls = this.containerEl.querySelectorAll('ul.plugin-tasks-query-result');
        var ulsToProcess = [];
        for (var u = 0; u < topUls.length; u++) {
            var ul = topUls[u];
            // A top-level UL's parent is the container div created by Tasks, not an <li>.
            if (ul.parentElement && ul.parentElement.tagName === 'LI') continue;
            ulsToProcess.push(ul);
        }
        if (ulsToProcess.length === 0) return;

        var index = this._plugin && typeof this._plugin.getIndex === 'function'
            ? this._plugin.getIndex(allTasks)
            : buildIndex(allTasks);
        log('processing ' + ulsToProcess.length + ' task list(s)');

        for (var i = 0; i < ulsToProcess.length; i++) {
            if (this._unloaded) return;
            await this._processOneUl(ulsToProcess[i], index);
        }
    };

    // -- per-UL processing -------------------------------------------
    AncestorRenderChild.prototype._processOneUl = async function (ul, index) {
        // Nothing changed since we last rebuilt this list -> leave it alone.
        // Without this the 400ms debounce rebuilds the whole tree on every
        // unrelated mutation, which flickers.
        if (ul.getAttribute('data-tav-sig') === ulSignature(ul)) return;

        // Back to flat before matching. Ancestor <li>s from an earlier pass
        // carry the task-list-item class but no .tasks-list-text, so left in
        // place they fall through matching and pile up at the end of the list.
        flattenOurTree(ul);

        // 1) Gather <li> elements that are direct children + task items.
        var directLis = [];
        for (var c = 0; c < ul.children.length; c++) {
            if (ul.children[c].tagName === 'LI') directLis.push(ul.children[c]);
        }
        if (directLis.length === 0) return;

        var t0 = Date.now();

        // 2) Read each <li>'s match signals once.
        var pending = [];
        var unmatched = [];
        for (var i = 0; i < directLis.length; i++) {
            var li = directLis[i];
            if (!li.classList.contains('task-list-item')) { unmatched.push(li); continue; }

            var textEl = ownQuery(li, '.tasks-list-text');
            var renderedText = normalizeWS(textEl ? textEl.textContent : '');
            if (!renderedText) { unmatched.push(li); continue; }

            var linkEl = ownQuery(li, 'a.internal-link');
            var idEl = ownQuery(li, '.task-id');

            pending.push({
                li: li,
                text: renderedText,
                backlink: linkEl ? (linkEl.textContent || '').trim() : '',
                // id emoji from the rendered DOM - globally unique per source line.
                id: idEl ? (idEl.textContent || '').replace(/[\u{1F194}\s]+/gu, '').trim() : ''
            });
        }

        // 3) Match. id first, then a global best-score assignment - matchItems
        //    owns the whole heuristic and is unit-tested.
        var result = matchItems(index, pending);
        for (var p = 0; p < result.unmatched.length; p++) unmatched.push(result.unmatched[p].li);

        log('matched=' + result.matches.length + '  unmatched=' + unmatched.length +
            '  in ' + (Date.now() - t0) + 'ms');
        if (result.matches.length === 0) return;

        // 4) Build ancestor tree. Matches stay in DOM order, so the tree keeps
        //    the sort order the Tasks query produced.
        var matches = [];
        for (var q = 0; q < result.matches.length; q++) {
            matches.push({ li: result.matches[q].item.li, task: result.matches[q].entry.task });
        }
        var root = buildTree(matches, {
            depth: this._directives.depth,
            descendants: this._wantsDescendants()
        });

        // 5) Detach all children from the UL (elements stay alive).
        while (ul.firstChild) ul.removeChild(ul.firstChild);

        // 6) Render ancestor tree back into the UL.
        await this._renderTree(ul, root);

        // 7) Append any unmatched items at the end (graceful fallback).
        for (var j = 0; j < unmatched.length; j++) {
            ul.appendChild(unmatched[j]);
        }

        ul.setAttribute('data-tav-sig', ulSignature(ul));
    };

    // -- rendering ---------------------------------------------------
    AncestorRenderChild.prototype._renderTree = async function (parentUl, treeNode) {
        for (var i = 0; i < treeNode.children.length; i++) {
            var child = treeNode.children[i];
            var li;

            if (child.matchedLi) {
                // Matching task -> reuse the original <li> so Tasks' own event
                // handlers (checkbox toggle, backlink click) survive the move.
                li = child.matchedLi;
                // Strip any stale nested UL left over from a prior render pass.
                stripNestedUls(li);
                li.setAttribute('data-tav', 'match');
                this._wireMatchedLi(li, child.item);
            } else {
                // Pure ancestor (not a matching task) -> create a new <li>.
                li = await this._createAncestorLi(child.item);
            }
            parentUl.appendChild(li);

            if (child.children.length > 0) {
                var nestedUl = document.createElement('ul');
                nestedUl.classList.add('contains-task-list', 'plugin-tasks-query-result');
                li.appendChild(nestedUl);
                await this._renderTree(nestedUl, child);
            }
        }
    };

    /**
     * Let the matched task's description open its source line too.
     *
     * Tasks only wires its backlink, so the description itself does nothing on
     * click - which reads as inconsistent once the grey ancestor and descendant
     * rows around it are all clickable.
     *
     * This <li> belongs to Tasks and is MOVED between passes rather than
     * rebuilt, so the listener is attached once and everything that can change
     * is read at click time:
     *   - the item hangs off the element, not a closure, because Tasks hands us
     *     a fresh Task object on every re-parse and a captured one goes stale;
     *   - the setting is read inside the handler, so toggling it needs no rewiring.
     */
    AncestorRenderChild.prototype._wireMatchedLi = function (li, item) {
        li._tavItem = item;

        var enabled = this._settings().clickToOpen && !!itemLocation(item);
        li.classList.toggle('tasks-ancestor-clickable-task', enabled);

        var span = ownQuery(li, '.tasks-list-text');
        if (!span) return;
        // Read every pass, unlike the listeners below: a row that cannot open
        // must not stay a tab stop after the setting is turned off. The element
        // belongs to Tasks, so leave nothing of ours behind when disabled.
        if (enabled) {
            span.setAttribute('tabindex', '0');
            span.setAttribute('role', 'link');
        } else {
            span.removeAttribute('tabindex');
            span.removeAttribute('role');
        }

        if (li.getAttribute('data-tav-click')) return;
        li.setAttribute('data-tav-click', '1');

        var self = this;
        var open = function (evt, newTab) {
            if (!self._settings().clickToOpen) return;
            var loc = itemLocation(li._tavItem);
            if (!loc) return;
            // _openSource steps aside for tags and the backlink (closest('a')),
            // so those keep running Tasks' own handlers.
            self._openSource(loc, li._tavItem, evt, newTab).catch(function (e) {
                console.error('Tasks Ancestor View v' + VERSION + ': open failed', e);
            });
        };
        wireOpenGestures(span, open, function (target) { self._anchorScroll(target); });
    };

    /**
     * Create an <li> for a non-matching ancestor item.
     * Uses the item's original markdown (stripped of checkbox prefix) as text.
     */
    AncestorRenderChild.prototype._createAncestorLi = async function (item) {
        var li = document.createElement('li');
        var md = (item && item.originalMarkdown) || '';
        var desc = stripCheckbox(md);
        // Emoji metadata rendered as raw text is the single noisiest thing on
        // an ancestor row - an auto-assigned id in the middle of a sentence
        // reads as a typo. Pull it out and re-render it as Tasks-styled spans.
        var meta = splitMetadata(desc);

        // Tasks plugin treats `- [ ]` without the global filter (e.g. #task)
        // as a plain ListItem (isTask=false). But visually the user still
        // wrote a checkbox in source - surface it as a checkbox in the view.
        var isTask = !!(item && item.isTask);
        var checkboxMatch = md.match(/^\s*[-*]\s*\[(.)\]\s*/);
        var hasCheckbox = isTask || !!checkboxMatch;
        var symbol = (item && item.status && item.status.symbol)
            ? item.status.symbol
            : (checkboxMatch ? checkboxMatch[1] : ' ');
        var isChecked = (item && item.isDone) || (checkboxMatch && /[^ ]/.test(checkboxMatch[1]));

        if (hasCheckbox) {
            li.classList.add('task-list-item');
            li.setAttribute('data-task', (symbol || ' ').trim());

            var checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.classList.add('task-list-item-checkbox');
            checkbox.readOnly = true;
            checkbox.disabled = true;
            if (isChecked) checkbox.checked = true;
            li.appendChild(checkbox);
        }

        var span = document.createElement('span');
        span.classList.add('tasks-ancestor-label');
        // Use Obsidian's MarkdownRenderer so tags become <a class="tag"> elements
        // that colored-tags and other plugins can style.
        var sourcePath = (this._ctx && this._ctx.sourcePath) || '';
        await obsidian.MarkdownRenderer.render(
            this._app, meta.text, span, sourcePath, this
        );
        // MarkdownRenderer wraps content in <p>; unwrap for inline display.
        var rendered = span.querySelector('p');
        if (rendered) {
            while (rendered.firstChild) span.insertBefore(rendered.firstChild, rendered);
            rendered.remove();
        }
        li.appendChild(span);

        // Metadata goes outside the label so a click on a date does not count
        // as clicking the item's text.
        for (var f = 0; f < meta.fields.length; f++) {
            var field = meta.fields[f];
            if (!field.show) continue;
            var badge = li.createEl('span', { cls: field.cls + ' tasks-ancestor-meta' });
            badge.textContent = field.value ? field.symbol + ' ' + field.value : field.symbol;
        }

        li.classList.add('tasks-ancestor-item');
        // Marks this <li> as ours so the next pass can discard it - see
        // _processOneUl. Without the marker these accumulate at list end.
        li.setAttribute('data-tav', 'ancestor');

        // An ancestor is context, not a query result, so Tasks gives it no
        // backlink. Make the label open its source line instead, so it behaves
        // like the matched tasks around it.
        var loc = this._settings().clickToOpen ? itemLocation(item) : null;
        if (!loc && this._settings().clickToOpen) {
            // No location -> no click handler and no pointer cursor. Worth
            // saying out loud; otherwise it reads as "clicking is broken".
            log('no source location for ancestor: ' + JSON.stringify(desc).slice(0, 60));
        }
        if (loc) {
            var self = this;
            li.classList.add('tasks-ancestor-clickable');
            span.setAttribute('aria-label', loc.path + ':' + (loc.line + 1));
            span.setAttribute('tabindex', '0');
            span.setAttribute('role', 'link');
            // addEventListener, not registerDomEvent: ancestor <li>s are thrown
            // away and rebuilt on every pass. Registering on the component would
            // pin every discarded element's handler for the block's lifetime.
            // _openSource is async - an unhandled rejection here would be
            // invisible to the user, so report it and move on.
            var open = function (evt, newTab) {
                self._openSource(loc, item, evt, newTab).catch(function (e) {
                    console.error('Tasks Ancestor View v' + VERSION + ': open failed', e);
                });
            };
            wireOpenGestures(span, open, function (target) { self._anchorScroll(target); });
        }
        return li;
    };

    /** Remember where the clicked view was, before anything can move it. */
    AncestorRenderChild.prototype._anchorScroll = function (el) {
        var scroller = findScroller(el);
        this._scrollAnchor = scroller ? {
            el: scroller,
            top: scroller.scrollTop,
            left: scroller.scrollLeft,
            at: Date.now(),
        } : null;
    };

    /**
     * Put the clicked view back where it was.
     *
     * Clicking a row in a pane Obsidian has not focused yet makes it activate
     * that leaf, and something on that path moves the reading view's scroll -
     * only on that first click, which is why it looks random. We then hand
     * focus straight on to the tab we just opened, so the user is left staring
     * at a list that jumped for no visible reason. Whatever moves it, the rule
     * we want is the same: opening a file somewhere else must not disturb the
     * list you clicked from.
     *
     * The scroll has already happened by the time our click handler returns, so
     * a synchronous restore is too early - it would run before the handlers
     * that move it. rAF catches the frame after every sync handler of that
     * click; the timeout catches whatever Obsidian does asynchronously after.
     */
    AncestorRenderChild.prototype._restoreScroll = function (anchor) {
        if (!anchor || !anchor.el || typeof requestAnimationFrame !== 'function') return;

        var self = this;
        var el = anchor.el;
        var cancelled = false;
        var cancel = function () { cancelled = true; };
        // Never fight a user who started scrolling in the meantime.
        var events = ['wheel', 'touchmove', 'keydown'];
        for (var i = 0; i < events.length; i++) {
            el.addEventListener(events[i], cancel, true);
        }

        var apply = function () {
            if (cancelled || self._unloaded) return;
            var now = el.scrollTop;
            if (Math.abs(now - anchor.top) < 1) return;
            el.scrollTop = anchor.top;
            el.scrollLeft = anchor.left;
            log('scroll restored: ' + Math.round(now) + ' -> ' + Math.round(anchor.top) +
                ' (delta ' + Math.round(now - anchor.top) + ')');
        };

        requestAnimationFrame(apply);
        setTimeout(function () {
            apply();
            for (var j = 0; j < events.length; j++) {
                el.removeEventListener(events[j], cancel, true);
            }
        }, 150);
    };

    /**
     * The leaf a brand-new tab should live in.
     *
     * Returns { leaf, reveal }; reveal is true when the caller must surface the
     * tab itself, which createLeafInParent does not do.
     *
     * Clicking here means leaving a query view you probably want to keep in
     * sight, so when the workspace is already split we put the file in the
     * OTHER half rather than on top of the block that was clicked.
     */
    AncestorRenderChild.prototype._newLeafFor = function (pane) {
        var workspace = this._app.workspace;
        // A modifier asked for something specific - honour it verbatim.
        if (pane !== 'tab') return { leaf: workspace.getLeaf(pane), reveal: false };

        var mobile = obsidian.Platform && obsidian.Platform.isMobile;
        if (!this._settings().openInOtherSplit || mobile) {
            return { leaf: workspace.getLeaf('tab'), reveal: false };
        }

        var root = workspace.rootSplit;
        var leaves = allLeaves(workspace);
        var host = findHostLeaf(leaves, this.containerEl) ||
            (typeof workspace.getMostRecentLeaf === 'function' ? workspace.getMostRecentLeaf(root) : null);
        // Without a host, or on an API that predates leaf.parent, we cannot
        // tell a split workspace from a single one - do not guess at the
        // layout, just behave the way this plugin always has.
        if (!host || !host.parent) return { leaf: workspace.getLeaf('tab'), reveal: false };

        var group = findOtherGroup(leaves, host, root);

        if (!group) {
            // Not split yet - make the second half rather than stacking a tab.
            log('workspace not split; splitting');
            return { leaf: workspace.getLeaf('split'), reveal: false };
        }

        if (typeof workspace.createLeafInParent === 'function') {
            try {
                var index = (group.children && group.children.length) || 0;
                var leaf = workspace.createLeafInParent(group, index);
                if (leaf) {
                    log('opening in the other split (tab ' + index + ')');
                    return { leaf: leaf, reveal: true };
                }
            } catch (e) {
                console.error('Tasks Ancestor View v' + VERSION + ': createLeafInParent failed', e);
            }
        }
        return { leaf: workspace.getLeaf('tab'), reveal: false };
    };

    /**
     * Open the ancestor item's source line.
     *
     * @param newTab true for a middle click; otherwise ctrl/cmd decides (same
     *               gesture set as Tasks' backlink).
     */
    AncestorRenderChild.prototype._openSource = async function (loc, item, evt, newTab) {
        // Tags and links inside the label render as real <a> elements (that is
        // why we render the markdown at all) - let them handle their own clicks.
        if (evt.target && evt.target.closest && evt.target.closest('a')) return;

        evt.preventDefault();
        evt.stopPropagation();

        var app = this._app;
        var file = app.vault.getAbstractFileByPath(loc.path);
        if (!file || (obsidian.TFile && !(file instanceof obsidian.TFile))) {
            new obsidian.Notice('Tasks Ancestor View: source file not found - ' + loc.path);
            return;
        }

        var line = loc.line;
        try {
            var content = await app.vault.cachedRead(file);
            line = resolveLine(content.split('\n'), (item && item.originalMarkdown) || '', loc.line);
        } catch (e) {
            // Still open the file - a stale line number beats not opening at all.
            console.error('Tasks Ancestor View v' + VERSION + ': source read failed', e);
        }

        // Every click opens a new tab (in the other split when there is one -
        // see _newLeafFor). Clicking here means leaving a query view you
        // probably want to keep, and Tasks' own backlink is already the
        // "open in the current tab" gesture on the same row.
        //
        // A modifier can still ask for something other than a tab: isModEvent()
        // answers 'tab' | 'split' | 'window' (or false for a bare click).
        var pane = 'tab';
        if (!newTab && obsidian.Keymap && obsidian.Keymap.isModEvent) {
            var mod = obsidian.Keymap.isModEvent(evt);
            if (typeof mod === 'string') pane = mod;
        }

        // Already open -> go to that tab instead of opening a second copy.
        var existing = findOpenLeaf(app.workspace, file.path);
        var leaf = existing;
        var reveal = !!existing;
        if (!leaf) {
            var made = this._newLeafFor(pane);
            leaf = made.leaf;
            reveal = made.reveal;
        }

        // A reused tab may still be deferred; loading it first keeps the
        // scroll-to-line reliable.
        if (existing && typeof existing.loadIfDeferred === 'function') {
            await existing.loadIfDeferred();
        }

        await leaf.openFile(file, { eState: { line: line } });
        if (reveal) {
            // openFile applies the eState but does not necessarily surface the
            // tab - neither one it was already sitting in, nor a fresh tab we
            // created in the other split.
            await app.workspace.revealLeaf(leaf);
            app.workspace.setActiveLeaf(leaf, { focus: true });
        }

        var anchor = this._scrollAnchor;
        this._scrollAnchor = null;
        // Opening into the very leaf our block lives in means the scroll IS the
        // point (the source line is in this note) - leave it alone. A stale
        // anchor from some earlier click is not ours to act on either.
        var here = leaf && leaf.containerEl && typeof leaf.containerEl.contains === 'function' &&
            leaf.containerEl.contains(this.containerEl);
        if (anchor && !here && Date.now() - anchor.at < 1000) this._restoreScroll(anchor);
    };

    return AncestorRenderChild;
}(obsidian.MarkdownRenderChild || function () {}));

// --- Settings tab ---------------------------------------------------
var AncestorSettingTab = (function (_super) {
    AncestorSettingTab.prototype = Object.create(_super.prototype);
    AncestorSettingTab.prototype.constructor = AncestorSettingTab;

    function AncestorSettingTab(app, plugin) {
        var _this = _super.call(this, app, plugin) || this;
        _this.plugin = plugin;
        return _this;
    }

    AncestorSettingTab.prototype.display = function () {
        var plugin = this.plugin;
        var s = plugin.settings;
        var el = this.containerEl;
        el.empty();

        new obsidian.Setting(el)
            .setName('하위 항목도 함께 표시')
            .setDesc(
                '매칭된 태스크 아래에 달린 하위 항목(#task가 아닌 체크박스·일반 목록)까지 ' +
                '트리에 펼칩니다. 끄면 조상 체인만 남습니다. ' +
                '블록 안에 hide descendants / show descendants 를 쓰면 그 블록에서는 그쪽이 우선합니다.'
            )
            .addToggle(function (t) {
                t.setValue(s.showDescendants).onChange(async function (v) {
                    s.showDescendants = v;
                    await plugin.saveSettings();
                });
            });

        new obsidian.Setting(el)
            .setName('클릭하면 원본으로 이동')
            .setDesc(
                '항목의 텍스트를 클릭하면 그 줄이 있는 노트를 새 탭에서 엽니다. ' +
                '이미 열려 있는 노트면 새로 열지 않고 그 탭으로 이동합니다. ' +
                '현재 탭에서 열려면 태스크 줄의 백링크를 쓰세요.'
            )
            .addToggle(function (t) {
                t.setValue(s.clickToOpen).onChange(async function (v) {
                    s.clickToOpen = v;
                    await plugin.saveSettings();
                });
            });

        new obsidian.Setting(el)
            .setName('새 탭을 다른 분할에 열기')
            .setDesc(
                '화면이 좌우(또는 상하)로 나누어져 있으면 새 탭을 반대쪽 분할에 엽니다. ' +
                '분할이 없으면 화면을 나누어 그쪽에 엽니다. ' +
                '끄면 지금 보고 있는 탭 그룹에 새 탭으로 열립니다. ' +
                '이미 열려 있는 노트라면 어느 쪽이든 그 탭으로 이동합니다.'
            )
            .addToggle(function (t) {
                t.setValue(s.openInOtherSplit).onChange(async function (v) {
                    s.openInOtherSplit = v;
                    await plugin.saveSettings();
                });
            });

        new obsidian.Setting(el)
            .setName('재구성 대기 시간')
            .setDesc(
                'Tasks가 목록을 다시 그린 뒤 트리를 재구성하기까지 기다리는 시간(ms). ' +
                '짧으면 반응이 빠르고, 길면 렌더가 끝나기를 더 확실히 기다립니다. ' +
                '50~5000 범위로 보정되며 기본값은 400입니다.'
            )
            .addText(function (t) {
                t.setPlaceholder(String(DEFAULT_SETTINGS.debounceMs))
                    .setValue(String(s.debounceMs))
                    .onChange(async function (v) {
                        // display()를 다시 부르지 않는다 - 입력 중 재렌더하면 포커스가 날아간다.
                        // 화면의 값은 그대로 두고 저장되는 값만 범위 안으로 보정한다.
                        var n = parseInt(v, 10);
                        if (!isFinite(n)) return;
                        s.debounceMs = clampDebounce(n, DEFAULT_SETTINGS.debounceMs);
                        await plugin.saveSettings();
                    });
            });

        new obsidian.Setting(el)
            .setName('디버그 로그')
            .setDesc(
                '매칭 결과와 소요 시간을 개발자 콘솔에 출력합니다. ' +
                "설정을 열기 어려운 기기에서는 콘솔에서 localStorage.setItem('tav-debug','1')로도 켤 수 있습니다."
            )
            .addToggle(function (t) {
                t.setValue(s.debug).onChange(async function (v) {
                    s.debug = v;
                    await plugin.saveSettings();
                });
            });
    };

    return AncestorSettingTab;
}(obsidian.PluginSettingTab || function () {}));

// --- export (Obsidian expects CJS default export) -------------------
Object.defineProperty(exports, '__esModule', { value: true });
exports.default = TasksAncestorPlugin;

// Pure helpers, exported for `node --test`. Obsidian only reads .default.
exports._internals = {
    VERSION: VERSION,
    stripCheckbox: stripCheckbox,
    normalizeWS: normalizeWS,
    plainify: plainify,
    splitMetadata: splitMetadata,
    itemKey: itemKey,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    clampDebounce: clampDebounce,
    parseDirectives: parseDirectives,
    trimChain: trimChain,
    mergeSettings: mergeSettings,
    itemLocation: itemLocation,
    resolveLine: resolveLine,
    leafFilePath: leafFilePath,
    findOpenLeaf: findOpenLeaf,
    backlinkBonus: backlinkBonus,
    scoreEntry: scoreEntry,
    buildIndex: buildIndex,
    matchItems: matchItems,
    buildTree: buildTree,
    childList: childList,
    findHostLeaf: findHostLeaf,
    findScroller: findScroller,
    findOtherGroup: findOtherGroup
};
