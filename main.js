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

var VERSION = '2.1.0';

// Deepest ancestor chain / descendant recursion we will follow.
var MAX_DEPTH = 20;

// require() is wrapped so this file can also be loaded by `node --test`,
// where the 'obsidian' module does not exist. Only the pure helpers at the
// top of the file are exercised there; the plugin classes are never
// instantiated outside Obsidian.
var obsidian = (function () {
    try { return require('obsidian'); } catch (e) { return {}; }
})();

// --- logging --------------------------------------------------------
// Rendering happens on every Tasks re-render, so per-pass logs are opt-in:
//   localStorage.setItem('tav-debug', '1')   in the developer console.
function debugEnabled() {
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

    TasksAncestorPlugin.prototype.onload = function () {
        var plugin = this;
        log('loaded');

        this.registerMarkdownCodeBlockProcessor('tasks-ancestors', function (source, el, ctx) {
            plugin.app.workspace.onLayoutReady(function () {
                var child = new AncestorRenderChild(plugin.app, el, source, ctx);
                ctx.addChild(child);
                child.load();
            });
        });
    };

    TasksAncestorPlugin.prototype.onunload = function () {
        log('unloaded');
    };

    return TasksAncestorPlugin;
}(obsidian.Plugin || function () {}));

// --- Render Child ---------------------------------------------------
var AncestorRenderChild = (function (_super) {
    AncestorRenderChild.prototype = Object.create(_super.prototype);
    AncestorRenderChild.prototype.constructor = AncestorRenderChild;

    function AncestorRenderChild(app, containerEl, source, ctx) {
        var _this = _super.call(this, containerEl) || this;
        _this._app = app;
        _this._source = source;
        _this._ctx = ctx;
        _this._observer = null;
        _this._timeout = null;
        _this._processing = false;
        _this._unloaded = false;
        return _this;
    }

    // -- lifecycle ---------------------------------------------------
    AncestorRenderChild.prototype.onload = function () {
        var self = this;

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
            self._timeout = setTimeout(function () { self._processResults(); }, 400);
        });
        this._observer.observe(this.containerEl, { childList: true, subtree: true, characterData: true });
    };

    AncestorRenderChild.prototype.onunload = function () {
        this._unloaded = true;
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

        // Drop ancestor <li>s left over from an earlier pass. They carry the
        // task-list-item class but no .tasks-list-text, so they would fall
        // through matching into `unmatched` and pile up at the end of the list.
        var stale = [];
        for (var s = 0; s < ul.children.length; s++) {
            var staleEl = ul.children[s];
            if (staleEl.getAttribute && staleEl.getAttribute('data-tav') === 'ancestor') stale.push(staleEl);
        }
        for (var d = 0; d < stale.length; d++) ul.removeChild(stale[d]);

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
            this._attachDescendants(node, task, 0, new Set());
        }

        return root;
    };

    // Remove any nested <ul> children from an <li> - prevents accumulating
    // stale descendant lists across re-render passes.
    AncestorRenderChild.prototype._stripNestedUls = function (li) {
        var uls = [];
        for (var i = 0; i < li.children.length; i++) {
            if (li.children[i].tagName === 'UL') uls.push(li.children[i]);
        }
        for (var j = 0; j < uls.length; j++) li.removeChild(uls[j]);
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
                this._stripNestedUls(li);
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
        return li;
    };

    return AncestorRenderChild;
}(obsidian.MarkdownRenderChild || function () {}));

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
    backlinkBonus: backlinkBonus,
    scoreEntry: scoreEntry,
    buildIndex: buildIndex
};
