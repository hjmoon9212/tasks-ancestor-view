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

var VERSION = '2.4.1';

// Deepest ancestor chain / descendant recursion we will follow.
var MAX_DEPTH = 20;

var DEFAULT_SETTINGS = {
    // Tasks re-renders in bursts; we wait for the burst to settle before
    // rebuilding the tree. Too low rebuilds mid-render, too high visibly lags.
    debounceMs: 400,
    // Expand what lives *under* a matched task too (plain checkboxes and list
    // items that are not #task). Off = ancestor chain only.
    showDescendants: true,
    // Clicking an ancestor's label opens its source line.
    clickToOpen: true,
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
function plainify(s) {
    return (s || '')
        .replace(/!?\[\[([^\]|]+)\|([^\]]*)\]\]/g, '$2')   // [[note|alias]] -> alias
        .replace(/!?\[\[([^\]]+)\]\]/g, '$1')              // [[note]]       -> note
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')         // [label](url)   -> label
        .replace(/[*_~`]/g, '')                            // emphasis / code markers
        .replace(/<[^>]+>/g, '');                          // inline HTML
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

// Score one index entry against a rendered <li>. Returns 0 for "no match".
function scoreEntry(entry, renderedText, backlinkText) {
    var score = 0;

    // 1) Description-based match: strongest signal. The rendered
    //    .tasks-list-text always begins with the description, then
    //    appends metadata spans, so renderedText should contain desc.
    if (entry.desc) {
        if (renderedText === entry.desc) {
            score = 100;
        } else if (renderedText.indexOf(entry.desc) === 0) {
            score = 95;
        } else if (renderedText.indexOf(entry.desc) !== -1) {
            score = 80;
        }
    }

    // 2) Fallback: full-line match against originalMarkdown (legacy path).
    if (score === 0 && entry.stripped) {
        if (entry.stripped === renderedText) {
            score = 70;
        } else if (entry.stripped.indexOf(renderedText) !== -1) {
            score = 50;
        } else if (renderedText.indexOf(entry.stripped) !== -1) {
            score = 40;
        }
    }

    if (score === 0) return 0;
    return score + backlinkBonus(entry, backlinkText);
}

// Precompute every string comparison input once per render pass. Without
// this, matching is O(rendered <li> x all vault tasks) with two regex
// passes per comparison - and the cost multiplies by the number of group
// <ul>s a query produces.
function buildIndex(allTasks) {
    var byId = new Map();
    var byDesc = new Map();
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
        if (entry.desc) {
            if (!byDesc.has(entry.desc)) byDesc.set(entry.desc, []);
            byDesc.get(entry.desc).push(entry);
        }
    }

    return { byId: byId, byDesc: byDesc, entries: entries };
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
        this._children = new Set();

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

    TasksAncestorPlugin.prototype.onunload = function () {
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
        if (!this._children) return;
        this._children.forEach(function (child) { child.forceReprocess(); });
    };

    TasksAncestorPlugin.prototype.trackChild = function (child) {
        if (this._children) this._children.add(child);
    };

    TasksAncestorPlugin.prototype.untrackChild = function (child) {
        if (this._children) this._children.delete(child);
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
        _this._observer = null;
        _this._timeout = null;
        _this._processing = false;
        _this._unloaded = false;
        return _this;
    }

    // Read through to the plugin every time - settings can change while the
    // block is open, and the fallback keeps a detached child from throwing.
    AncestorRenderChild.prototype._settings = function () {
        return (this._plugin && this._plugin.settings) || DEFAULT_SETTINGS;
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

        // Strip show/hide tree/ancestors so Tasks does a clean flat render.
        var cleanSource = this._source
            .split('\n')
            .filter(function (l) { return !/^\s*(show|hide)\s+(tree|ancestors)\s*$/i.test(l); })
            .join('\n').trim();

        // Let the Tasks plugin render the flat query (100% DSL).
        log('requesting flat render');
        tasksPlugin.queryRenderer.addQueryRenderChild(cleanSource, this.containerEl, this._ctx);

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
        if (this._processing || this._unloaded || !this._observer) return;
        this._processing = true;
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

        var t0 = Date.now();
        var index = buildIndex(allTasks);
        log('processing ' + ulsToProcess.length + ' task list(s); indexed ' +
            index.entries.length + '/' + allTasks.length + ' tasks in ' + (Date.now() - t0) + 'ms');

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

        // 3) Match. Two passes so that id-bearing items claim their task
        //    first - a single greedy pass lets an earlier text-similarity
        //    match steal a task that a later id-bearing item owns outright.
        var matches = [];
        var usedTasks = new Set();
        var leftovers = [];

        for (var p = 0; p < pending.length; p++) {
            var item = pending[p];
            if (!item.id) { leftovers.push(item); continue; }

            var picked = this._pickById(index, item, usedTasks);
            if (picked) {
                matches.push({ li: item.li, task: picked.task });
                usedTasks.add(picked.task);
            } else {
                leftovers.push(item);   // unknown id -> fall back to text matching
            }
        }

        for (var q = 0; q < leftovers.length; q++) {
            var rest = leftovers[q];
            var found = this._pickByText(index, rest, usedTasks);
            if (found) {
                matches.push({ li: rest.li, task: found.task });
                usedTasks.add(found.task);
            } else {
                unmatched.push(rest.li);
            }
        }

        log('matched=' + matches.length + '  unmatched=' + unmatched.length +
            '  in ' + (Date.now() - t0) + 'ms');
        if (matches.length === 0) return;

        // 4) Build ancestor tree.
        var root = this._buildTree(matches);

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

    // -- matching ----------------------------------------------------
    // An id exact match is definitive. Multiple source lines can carry the
    // same id (gcal-sync assigns them automatically), so tiebreak on backlink.
    AncestorRenderChild.prototype._pickById = function (index, item, usedTasks) {
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
    };

    AncestorRenderChild.prototype._pickByText = function (index, item, usedTasks) {
        // Fast path: a task whose description equals the rendered text verbatim.
        var exact = index.byDesc.get(item.text);
        if (exact) {
            var hit = this._bestOf(exact, item, usedTasks);
            if (hit) return hit;
        }
        return this._bestOf(index.entries, item, usedTasks);
    };

    AncestorRenderChild.prototype._bestOf = function (pool, item, usedTasks) {
        var best = null;
        var bestScore = 0;
        for (var i = 0; i < pool.length; i++) {
            var entry = pool[i];
            if (usedTasks.has(entry.task)) continue;
            // Hard disambiguation: if both the rendered <li> and the task
            // carry an id, a mismatch is a definitive non-match.
            if (item.id && entry.id && item.id !== entry.id) continue;

            var score = scoreEntry(entry, item.text, item.backlink);
            if (score > bestScore) { bestScore = score; best = entry; }
        }
        return best;
    };

    // -- tree building -----------------------------------------------
    /**
     * Build a virtual tree from matched tasks by walking up each task's
     * .parent chain.  Shared ancestors are merged (compared by itemKey).
     *
     * Returns a virtual root node:
     *   { item:null, children:[], matchedLi:null }
     *
     * Each child node:
     *   { item:ListItem|Task, children:[], matchedLi:HTMLElement|null }
     */
    AncestorRenderChild.prototype._buildTree = function (matches) {
        var root = { item: null, children: [], matchedLi: null, _childMap: new Map() };

        for (var i = 0; i < matches.length; i++) {
            var task = matches[i].task;
            var li = matches[i].li;

            // Collect ancestor chain from root to task.
            var chain = [];
            var cur = task;
            var guard = 0;
            while (cur && guard++ < MAX_DEPTH) {
                chain.unshift(cur);
                cur = cur.parent;
            }

            // Walk / create tree nodes. Key by source-location identity so a
            // matched leaf and an ancestor referring to the same source line
            // collapse to a single node even when Tasks plugin returns
            // different JS objects for them.
            var node = root;
            for (var c = 0; c < chain.length; c++) {
                var item = chain[c];
                var key = itemKey(item);
                if (!node._childMap.has(key)) {
                    var newNode = { item: item, children: [], matchedLi: null, _childMap: new Map() };
                    node.children.push(newNode);
                    node._childMap.set(key, newNode);
                }
                node = node._childMap.get(key);
            }
            // The leaf node corresponds to the matching task.
            node.matchedLi = li;

            // Attach descendants of the matched task - plain `- [ ]` checkboxes
            // (without #task) and plain `-` list items that live under this
            // task in the source. itemKey-based merging means descendants that
            // are themselves matched leaves collapse onto their existing node.
            if (this._settings().showDescendants) {
                this._attachDescendants(node, task, 0, new Set());
            }
        }

        return root;
    };

    // -- descendants -------------------------------------------------
    AncestorRenderChild.prototype._attachDescendants = function (parentNode, item, depth, seen) {
        if (!item || depth >= MAX_DEPTH) return;
        var ch = item.children;
        if (!ch) return;

        // Guard against a malformed parent/child cycle in the Tasks cache -
        // one bad edge would otherwise recurse until the stack blows.
        var selfKey = itemKey(item);
        if (seen.has(selfKey)) return;
        seen.add(selfKey);

        var kids = [];
        if (ch instanceof Map) {
            ch.forEach(function (v) { kids.push(v); });
        } else if (Array.isArray(ch)) {
            kids = ch.slice();
        } else if (typeof ch.forEach === 'function') {
            ch.forEach(function (v) { kids.push(v); });
        } else if (typeof ch === 'object') {
            for (var k in ch) if (Object.prototype.hasOwnProperty.call(ch, k)) kids.push(ch[k]);
        }
        for (var i = 0; i < kids.length; i++) {
            var child = kids[i];
            var key = itemKey(child);
            var childNode;
            if (parentNode._childMap.has(key)) {
                childNode = parentNode._childMap.get(key);
            } else {
                childNode = { item: child, children: [], matchedLi: null, _childMap: new Map() };
                parentNode.children.push(childNode);
                parentNode._childMap.set(key, childNode);
            }
            this._attachDescendants(childNode, child, depth + 1, seen);
        }
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
     * Create an <li> for a non-matching ancestor item.
     * Uses the item's original markdown (stripped of checkbox prefix) as text.
     */
    AncestorRenderChild.prototype._createAncestorLi = async function (item) {
        var li = document.createElement('li');
        var md = (item && item.originalMarkdown) || '';
        var desc = stripCheckbox(md);

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
            this._app, desc, span, sourcePath, this
        );
        // MarkdownRenderer wraps content in <p>; unwrap for inline display.
        var rendered = span.querySelector('p');
        if (rendered) {
            while (rendered.firstChild) span.insertBefore(rendered.firstChild, rendered);
            rendered.remove();
        }
        li.appendChild(span);

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
            span.addEventListener('click', function (evt) { open(evt, false); });
            span.addEventListener('auxclick', function (evt) {
                if (evt.button === 1) open(evt, true);
            });
        }
        return li;
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

        var mod = !newTab && obsidian.Keymap && obsidian.Keymap.isModEvent
            ? obsidian.Keymap.isModEvent(evt)
            : false;

        // A new-tab gesture on a file that is already open goes to that tab
        // instead of making a second copy of it. A plain click reuses the
        // current tab anyway, so it never needs this.
        var existing = newTab || mod ? findOpenLeaf(app.workspace, file.path) : null;
        var leaf = existing || app.workspace.getLeaf(newTab ? 'tab' : mod);

        // A reused tab may still be deferred; loading it first keeps the
        // scroll-to-line reliable.
        if (existing && typeof existing.loadIfDeferred === 'function') {
            await existing.loadIfDeferred();
        }

        await leaf.openFile(file, { eState: { line: line } });
        if (existing) {
            // openFile applies the eState but does not necessarily surface the
            // tab it was already sitting in.
            await app.workspace.revealLeaf(leaf);
            app.workspace.setActiveLeaf(leaf, { focus: true });
        }
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
                '트리에 펼칩니다. 끄면 조상 체인만 남습니다.'
            )
            .addToggle(function (t) {
                t.setValue(s.showDescendants).onChange(async function (v) {
                    s.showDescendants = v;
                    await plugin.saveSettings();
                });
            });

        new obsidian.Setting(el)
            .setName('조상 클릭 시 원본으로 이동')
            .setDesc(
                '조상 항목의 텍스트를 클릭하면 그 줄이 있는 노트를 엽니다. ' +
                'Ctrl/Cmd+클릭과 가운데 클릭은 새 탭에서 엽니다.'
            )
            .addToggle(function (t) {
                t.setValue(s.clickToOpen).onChange(async function (v) {
                    s.clickToOpen = v;
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
    itemKey: itemKey,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    clampDebounce: clampDebounce,
    mergeSettings: mergeSettings,
    itemLocation: itemLocation,
    resolveLine: resolveLine,
    leafFilePath: leafFilePath,
    findOpenLeaf: findOpenLeaf,
    backlinkBonus: backlinkBonus,
    scoreEntry: scoreEntry,
    buildIndex: buildIndex
};
