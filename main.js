'use strict';

/*
 * Tasks Ancestor View v2.0.0
 * --------------------------
 * Companion plugin for Obsidian Tasks.
 *
 * Strategy (v2 – completely revised):
 *   1. Tasks plugin renders FLAT query results (100% DSL compatible).
 *   2. We match each rendered <li> to a Task object via getTasks()
 *      (text heuristic + backlink filename).
 *   3. Walk up each matched Task's .parent chain to collect ancestors.
 *   4. Restructure the flat DOM into an ancestor tree by MOVING the
 *      original <li> elements (preserves all event handlers).
 *   5. Ancestor items are created as new <li> with Obsidian markdown rendering.
 */

var obsidian = require('obsidian');

// ─── helpers ─────────────────────────────────────────────────────────
function stripCheckbox(md) {
    // "  * [x] description" → "description"
    // "  - description"     → "description"  (plain list item, no checkbox)
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

// Stable identity for a Task / ListItem so two different JS objects pointing
// to the same source line merge in the ancestor tree. Tasks plugin can re-parse
// and produce a fresh object for the same line; without this, the leaf's
// matched task and its own .parent chain may not share references, causing
// the same ancestor to render twice (once as ancestor, once as matched leaf).
function itemKey(item) {
    if (!item) return '';
    // 1) Tasks-plugin 🆔 — user-assigned, globally unique per source line.
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
    // 3) Last-resort fallback — collapses items with identical text in same
    //    file, which is acceptable since they would render identically anyway.
    return 'md:' + (item.originalMarkdown || '').trim() + '|' + path;
}

// ─── Plugin ──────────────────────────────────────────────────────────
var TasksAncestorPlugin = (function (_super) {
    TasksAncestorPlugin.prototype = Object.create(_super.prototype);
    TasksAncestorPlugin.prototype.constructor = TasksAncestorPlugin;
    function TasksAncestorPlugin() { return _super.apply(this, arguments) || this; }

    TasksAncestorPlugin.prototype.onload = function () {
        var plugin = this;
        console.log('Tasks Ancestor View v2: loaded');

        this.registerMarkdownCodeBlockProcessor('tasks-ancestors', function (source, el, ctx) {
            plugin.app.workspace.onLayoutReady(function () {
                var child = new AncestorRenderChild(plugin.app, el, source, ctx);
                ctx.addChild(child);
                child.load();
            });
        });
    };

    TasksAncestorPlugin.prototype.onunload = function () {
        console.log('Tasks Ancestor View v2: unloaded');
    };

    return TasksAncestorPlugin;
}(obsidian.Plugin));

// ─── Render Child ────────────────────────────────────────────────────
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
        return _this;
    }

    // ── lifecycle ────────────────────────────────────────────────────
    AncestorRenderChild.prototype.onload = function () {
        var self = this;

        var tasksPlugin = this._app.plugins && this._app.plugins.plugins &&
            this._app.plugins.plugins['obsidian-tasks-plugin'];

        if (!tasksPlugin || !tasksPlugin.queryRenderer) {
            this.containerEl.createEl('pre', {
                text: 'Tasks Ancestor View: "Tasks" plugin is not installed or not enabled.'
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
        console.log('Tasks Ancestor View v2: requesting flat render');
        tasksPlugin.queryRenderer.addQueryRenderChild(cleanSource, this.containerEl, this._ctx);

        // Watch for render completion / re-renders.
        this._observer = new MutationObserver(function () {
            clearTimeout(self._timeout);
            self._timeout = setTimeout(function () { self._processResults(); }, 400);
        });
        this._observer.observe(this.containerEl, { childList: true, subtree: true, characterData: true });
    };

    AncestorRenderChild.prototype.onunload = function () {
        if (this._observer) this._observer.disconnect();
        clearTimeout(this._timeout);
    };

    // ── core ─────────────────────────────────────────────────────────
    AncestorRenderChild.prototype._processResults = function () {
        if (this._processing) return;
        this._processing = true;
        this._observer.disconnect();

        var self = this;
        this._doProcess().catch(function (e) {
            console.error('Tasks Ancestor View v2: processing error', e);
        }).finally(function () {
            // Reconnect after a tick so our own DOM writes don't retrigger.
            setTimeout(function () {
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

        // Find every top-level <ul> (skip nested ones – those would be ours from a prior run).
        var topUls = this.containerEl.querySelectorAll('ul.plugin-tasks-query-result');
        var ulsToProcess = [];
        for (var u = 0; u < topUls.length; u++) {
            var ul = topUls[u];
            // A top-level UL's parent is the container div created by Tasks, not an <li>.
            if (ul.parentElement && ul.parentElement.tagName === 'LI') continue;
            ulsToProcess.push(ul);
        }
        if (ulsToProcess.length === 0) return;

        console.log('Tasks Ancestor View v2: processing ' + ulsToProcess.length + ' task list(s)');

        for (var i = 0; i < ulsToProcess.length; i++) {
            await this._processOneUl(ulsToProcess[i], allTasks);
        }
    };

    // ── per-UL processing ────────────────────────────────────────────
    AncestorRenderChild.prototype._processOneUl = async function (ul, allTasks) {
        // 1) Gather <li> elements that are direct children + task items.
        var directLis = [];
        for (var c = 0; c < ul.children.length; c++) {
            if (ul.children[c].tagName === 'LI') directLis.push(ul.children[c]);
        }
        if (directLis.length === 0) return;

        // 2) Match each <li> to a Task object.
        var matches = [];      // { li, task }
        var unmatched = [];    // li
        var usedTasks = new Set(); // prevent duplicate matches

        for (var i = 0; i < directLis.length; i++) {
            var li = directLis[i];
            if (!li.classList.contains('task-list-item')) { unmatched.push(li); continue; }

            var task = this._matchLiToTask(li, allTasks, usedTasks);
            if (task) {
                matches.push({ li: li, task: task });
                usedTasks.add(task);
            } else {
                unmatched.push(li);
            }
        }

        console.log('Tasks Ancestor View v2: matched=' + matches.length + '  unmatched=' + unmatched.length);
        if (matches.length === 0) return;

        // 3) Build ancestor tree.
        var root = this._buildTree(matches);

        // 4) Detach all children from the UL (elements stay alive).
        while (ul.firstChild) ul.removeChild(ul.firstChild);

        // 5) Render ancestor tree back into the UL.
        await this._renderTree(ul, root);

        // 6) Append any unmatched items at the end (graceful fallback).
        for (var j = 0; j < unmatched.length; j++) {
            ul.appendChild(unmatched[j]);
        }
    };

    // ── matching ─────────────────────────────────────────────────────
    AncestorRenderChild.prototype._matchLiToTask = function (li, allTasks, usedTasks) {
        var textEl = li.querySelector('.tasks-list-text');
        var renderedText = normalizeWS(textEl ? textEl.textContent : '');
        if (!renderedText) return null;

        var linkEl = li.querySelector('a.internal-link');
        var backlinkText = linkEl ? (linkEl.textContent || '').trim() : '';

        // 🆔 from the rendered DOM — used to disambiguate tasks that share
        // the same description (e.g. recurring "monthly batch" across months).
        var idEl = li.querySelector('.task-id');
        var renderedId = idEl ? (idEl.textContent || '').replace(/[🆔\s]+/gu, '').trim() : '';

        var bestTask = null;
        var bestScore = 0;

        for (var i = 0; i < allTasks.length; i++) {
            var task = allTasks[i];
            if (usedTasks.has(task)) continue;

            // Prefer task.description (no emoji metadata) — the Tasks plugin
            // re-orders metadata at render time, so originalMarkdown order won't
            // match the rendered DOM. description is metadata-free and stable.
            var desc = normalizeWS(task.description || '');
            var stripped = normalizeWS(stripCheckbox(task.originalMarkdown || ''));
            if (!desc && !stripped) continue;

            // Hard disambiguation: if both rendered <li> and task carry an 🆔,
            // they MUST match. Mismatched IDs are a definitive non-match,
            // regardless of description similarity.
            var taskId = (task.id || '').toString().trim();
            if (renderedId && taskId && renderedId !== taskId) continue;

            // 🆔 exact match is DEFINITIVE (globally unique per source line).
            // Seed a high base score so it survives text divergence between the
            // rendered DOM and the source markdown — e.g. `[label](url)` links
            // (DOM shows only the label) or Tasks reordering metadata. Without
            // this the task falls to score 0 → unmatched → dumped at list end
            // while it ALSO renders as another match's grey ancestor = duplicate.
            var idExact = !!(renderedId && taskId && renderedId === taskId);
            var score = idExact ? 1000 : 0;

            // 1) Description-based match: strongest signal. The rendered
            //    .tasks-list-text always begins with the description, then
            //    appends metadata spans, so renderedText should contain desc.
            if (!idExact && desc) {
                if (renderedText === desc) {
                    score = 100;
                } else if (renderedText.indexOf(desc) === 0) {
                    score = 95;
                } else if (renderedText.indexOf(desc) !== -1) {
                    score = 80;
                }
            }

            // 2) Fallback: full-line match against originalMarkdown (legacy path).
            if (!idExact && score === 0 && stripped) {
                if (stripped === renderedText) {
                    score = 70;
                } else if (stripped.includes(renderedText)) {
                    score = 50;
                } else if (renderedText.includes(stripped)) {
                    score = 40;
                }
            }

            if (score === 0) continue;

            // --- backlink / filename bonus (tiebreak, incl. same-🆔 edge case) ---
            if (backlinkText && task.filename) {
                if (backlinkText.includes(task.filename)) score += 25;
            }

            if (score > bestScore) {
                bestScore = score;
                bestTask = task;
            }
        }

        return bestTask;
    };

    // ── tree building ────────────────────────────────────────────────
    /**
     * Build a virtual tree from matched tasks by walking up each task's
     * .parent chain.  Shared ancestors are merged (compared by reference).
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
            while (cur) {
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

            // Attach descendants of the matched task — plain `- [ ]` checkboxes
            // (without #task) and plain `-` list items that live under this
            // task in the source. itemKey-based merging means descendants that
            // are themselves matched leaves collapse onto their existing node.
            this._attachDescendants(node, task);
        }

        return root;
    };

    // Remove any nested <ul> children from an <li> — prevents accumulating
    // stale descendant lists across re-render passes.
    AncestorRenderChild.prototype._stripNestedUls = function (li) {
        var uls = [];
        for (var i = 0; i < li.children.length; i++) {
            if (li.children[i].tagName === 'UL') uls.push(li.children[i]);
        }
        for (var j = 0; j < uls.length; j++) li.removeChild(uls[j]);
    };

    // ── descendants ──────────────────────────────────────────────────
    AncestorRenderChild.prototype._attachDescendants = function (parentNode, item) {
        if (!item) return;
        var ch = item.children;
        if (!ch) return;
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
            this._attachDescendants(childNode, child);
        }
    };

    // ── rendering ────────────────────────────────────────────────────
    AncestorRenderChild.prototype._renderTree = async function (parentUl, treeNode) {
        for (var i = 0; i < treeNode.children.length; i++) {
            var child = treeNode.children[i];
            var li;

            if (child.matchedLi && child.children.length === 0) {
                // Leaf matching task → reuse original <li> (event handlers preserved).
                li = child.matchedLi;
                // Strip any stale nested UL left over from a prior render pass.
                this._stripNestedUls(li);
                parentUl.appendChild(li);
            } else if (child.matchedLi && child.children.length > 0) {
                // Matching task that is ALSO an ancestor of other matches /
                // a parent of plain (non-task) descendants we want to surface.
                li = child.matchedLi;
                this._stripNestedUls(li);
                parentUl.appendChild(li);

                var nestedUl = document.createElement('ul');
                nestedUl.classList.add('contains-task-list', 'plugin-tasks-query-result');
                li.appendChild(nestedUl);
                await this._renderTree(nestedUl, child);
            } else {
                // Pure ancestor (not a matching task) → create a new <li>.
                li = await this._createAncestorLi(child.item);
                parentUl.appendChild(li);

                if (child.children.length > 0) {
                    var nestedUl2 = document.createElement('ul');
                    nestedUl2.classList.add('contains-task-list', 'plugin-tasks-query-result');
                    li.appendChild(nestedUl2);
                    await this._renderTree(nestedUl2, child);
                }
            }
        }
    };

    /**
     * Create an <li> for a non-matching ancestor item.
     * Uses the item's original markdown (stripped of checkbox prefix) as text.
     */
    AncestorRenderChild.prototype._createAncestorLi = async function (item) {
        var li = document.createElement('li');
        var md = item.originalMarkdown || '';
        var desc = stripCheckbox(md);

        // Tasks plugin treats `- [ ]` without the global filter (e.g. #task)
        // as a plain ListItem (isTask=false). But visually the user still
        // wrote a checkbox in source — surface it as a checkbox in the view.
        var isTask = !!item.isTask;
        var checkboxMatch = md.match(/^\s*[-*]\s*\[(.)\]\s*/);
        var hasCheckbox = isTask || !!checkboxMatch;
        var symbol = (item.status && item.status.symbol)
            ? item.status.symbol
            : (checkboxMatch ? checkboxMatch[1] : ' ');
        var isChecked = item.isDone || (checkboxMatch && /[^ ]/.test(checkboxMatch[1]));

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
        return li;
    };

    return AncestorRenderChild;
}(obsidian.MarkdownRenderChild));

// ─── export (Obsidian expects CJS default export) ────────────────────
Object.defineProperty(exports, '__esModule', { value: true });
exports.default = TasksAncestorPlugin;
