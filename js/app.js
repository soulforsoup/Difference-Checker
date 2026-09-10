"use strict";

(function () {
  function $(s) { return document.querySelector(s); }
  function $$(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      var a = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(null, a); }, ms);
    };
  }

  var Store = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };

  var ELS = {};
  ["themeToggle", "findBtn", "exampleBtn", "fileInput", "textLeft", "textRight",
   "comparingLabel", "settingsPanel", "settingsWrap1", "settingsWrap2",
   "settingsBtn1", "settingsBtn2", "optsBadge1", "optsBadge2", "diffBody", "diffScroll",
   "diffRegion", "langSel", "hideUnchangedBtn", "wrapBtn", "statAdd", "statDel", "statSame",
   "legendChip", "modeNote", "dropVeil", "resultToolbar", "resultFiles", "comparePlaceholder"]
    .forEach(function (id) { ELS[id] = $("#" + id); });
  ELS.countLeft = $("[data-count='left']");
  ELS.countRight = $("[data-count='right']");
  ELS.metaLeft = $("[data-meta='left']");
  ELS.metaRight = $("[data-meta='right']");
  ELS.rfnLeft = $("[data-rfn='left']");
  ELS.rfnRight = $("[data-rfn='right']");
  ELS.dirtyBadge = $("#dirtyBadge");
  ELS.settingsBtns = [ELS.settingsBtn1, ELS.settingsBtn2];
  ELS.optsBadges = [ELS.optsBadge1, ELS.optsBadge2];
  ELS.overlay = $("#comparingOverlay");
  ELS.clearBtns = { left: $("[data-clear='left']"), right: $("[data-clear='right']") };
  ELS.clearAllBtn = $("#clearAllBtn");

  var DEFAULT_OPTS = {
    ignoreWhitespace: false, ignoreCase: false, ignoreLineEndings: false,
    ignoreQuotes: false, ignoreDashes: false,
    transformTrim: false, transformLower: false, transformSort: false, transformBreaks: false
  };

  var state = {
    opts: Object.assign({}, DEFAULT_OPTS, Store.get("dc-opts", {})),
    precision: Store.get("dc-precision", "smart"),
    lang: Store.get("dc-lang", "plaintext"),
    view: Store.get("dc-view", "side"),
    wrap: Store.get("dc-wrap", true),
    hideUnchanged: Store.get("dc-hide", true),
    compared: false,
    comparing: false
  };

  var meta = { left: null, right: null };
  var cmp = null;
  var seqToken = 0;
  var msgSeq = 0;
  var pendingWorker = {};
  var renderToken = 0;
  var expandedRuns = {};

  var worker = null;
  try { worker = new Worker("js/compare.worker.js"); } catch (e) {}
  if (worker) {
    worker.addEventListener("message", function (ev) {
      var d = ev.data, h = pendingWorker[d.id];
      if (h) {
        delete pendingWorker[d.id];
        h(d);
      }
    });
    worker.addEventListener("error", function () {
      var ids = Object.keys(pendingWorker);
      ids.forEach(function (id) {
        var h = pendingWorker[id];
        delete pendingWorker[id];
        h({ error: true });
      });
    });
  }

  var LANG_FILES = ["javascript", "typescript", "python", "java", "csharp", "cpp", "go", "rust",
    "ruby", "php", "kotlin", "swift", "xml", "css", "json", "yaml", "ini", "sql", "bash",
    "markdown", "diff", "http", "dockerfile", "makefile", "plaintext"];
  var ALIAS = { html: { file: "xml", lang: "xml" } };
  var loadedLangs = {};
  var loadingLangs = {};

  function injectScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = res;
      s.onerror = function () { rej(new Error("script " + src)); };
      document.head.appendChild(s);
    });
  }

  function ensureLang(id) {
    var a = ALIAS[id];
    var file = a ? a.file : id;
    var lang = a ? a.lang : id;
    if (file === "plaintext") return Promise.resolve("plaintext");
    if (loadedLangs[file] !== undefined) return Promise.resolve(loadedLangs[file] ? lang : null);
    if (loadingLangs[file]) return loadingLangs[file];
    var p = injectScript("js/vendor/hljs-langs/" + file + ".min.js").then(function () {
      loadedLangs[file] = true;
      return lang;
    }, function () {
      loadedLangs[file] = false;
      return null;
    });
    loadingLangs[file] = p;
    return p;
  }

  function ensureAuto() {
    return Promise.all(LANG_FILES.map(ensureLang)).then(function () { return true; });
  }

  function countLines(t) {
    if (!t) return 0;
    var n = 1, i;
    for (i = 0; i < t.length; i++) {
      var c = t.charCodeAt(i);
      if (c === 10 || c === 13) n++;
    }
    return n;
  }

  function setCount(el, t) {
    el.textContent = countLines(t) + " lines \u00b7 " + t.length.toLocaleString() + " characters";
  }

  function updateCounters() {
    setCount(ELS.countLeft, ELS.textLeft.value);
    setCount(ELS.countRight, ELS.textRight.value);
    var hasLeft = ELS.textLeft.value.length > 0;
    var hasRight = ELS.textRight.value.length > 0;
    ELS.clearBtns.left.disabled = !hasLeft;
    ELS.clearBtns.right.disabled = !hasRight;
    ELS.clearAllBtn.disabled = !hasLeft && !hasRight;
  }

  function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }

  function setFileMeta(side, name, size) {
    meta[side] = name ? { name: name, size: size } : null;
    var el = side === "left" ? ELS.metaLeft : ELS.metaRight;
    el.textContent = meta[side] ? meta[side].name + " \u00b7 " + fmtBytes(meta[side].size) : "";
  }

  function anyActiveOpt() {
    var k;
    for (k in state.opts) if (state.opts[k]) return true;
    return state.lang !== "plaintext";
  }

  function optionBadge() {
    var on = anyActiveOpt();
    ELS.optsBadges.forEach(function (b) { b.hidden = !on; });
  }

  function setOpt(key, val) {
    state.opts[key] = val;
    Store.set("dc-opts", state.opts);
    optionBadge();
    scheduleRefresh();
  }

  function activeModeNote() {
    var o = state.opts, parts = [];
    if (o.ignoreWhitespace) parts.push("hiding whitespace changes");
    if (o.ignoreCase) parts.push("ignoring case");
    if (o.ignoreLineEndings) parts.push("ignoring line endings");
    if (o.ignoreQuotes) parts.push("ignoring quotation marks");
    if (o.ignoreDashes) parts.push("ignoring dashes");
    if (o.transformTrim) parts.push("lines trimmed");
    if (o.transformLower) parts.push("text lowercased");
    if (o.transformSort) parts.push("lines sorted alphabetically");
    if (o.transformBreaks) parts.push("line breaks replaced with spaces");
    if (state.lang === "auto") parts.push("language auto-detected");
    else if (state.lang !== "plaintext") parts.push("language: " + state.lang);
    return parts.join(", ");
  }

  var WS_RE = /^[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]*$/;
  var WS_FOLD = /[ \t\f\v\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/g;
  var WS_TRIM = /^[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+|[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+$/g;

  function foldLine(s, o) {
    var out = s, i, ch, code, res;
    if (o.ignoreQuotes || o.ignoreDashes) {
      res = "";
      for (i = 0; i < s.length; i++) {
        ch = s.charAt(i);
        code = s.charCodeAt(i);
        if (o.ignoreQuotes && (code === 0x2018 || code === 0x2019 || code === 0x201A || code === 0x201B ||
            code === 0x2032 || code === 0x60 || code === 0xB4 || code === 0x2039)) ch = "'";
        else if (o.ignoreQuotes && (code === 0x201C || code === 0x201D || code === 0x201E || code === 0x201F ||
            code === 0xAB || code === 0xBB || code === 0x203A)) ch = '"';
        else if (o.ignoreDashes && ((code >= 0x2010 && code <= 0x2015) || code === 0x2212 || code === 0xFE58 || code === 0xFE63)) ch = "-";
        res += ch;
      }
      out = res;
    }
    if (o.ignoreCase) out = out.toLocaleLowerCase();
    if (o.ignoreWhitespace) out = out.replace(WS_FOLD, " ").replace(WS_TRIM, "");
    return out;
  }

  function splitRaw(text) {
    if (!text) return [];
    var lines = [], re = /\r\n|\r|\n/g, m, last = 0;
    while ((m = re.exec(text))) {
      lines.push({ t: text.slice(last, m.index), cr: m[0].length > 1 || m[0] === "\r" });
      last = m.index + m[0].length;
    }
    if (last < text.length || last === 0) lines.push({ t: text.slice(last), cr: false });
    return lines;
  }

  function buildLines(text, o) {
    var raw = splitRaw(text);
    var ds = raw.map(function (l, i) { return { t: l.t, cr: l.cr, n: i + 1 }; });
    var moved = o.transformSort || o.transformBreaks;
    if (o.transformTrim) ds = ds.map(function (l) { return { t: l.t.replace(WS_TRIM, ""), cr: l.cr, n: l.n }; });
    if (o.transformLower) ds = ds.map(function (l) { return { t: l.t.toLocaleLowerCase(), cr: l.cr, n: l.n }; });
    if (o.transformSort) {
      ds = ds.slice().sort(function (a, b) {
        var r = a.t.localeCompare(b.t, undefined, { sensitivity: "variant" });
        return r !== 0 ? r : a.n - b.n;
      });
    }
    if (o.transformBreaks) {
      ds = ds.length ? [{ t: ds.map(function (l) { return l.t; }).join(" "), cr: false, n: 0 }] : [];
    }
    return ds.map(function (l, idx) {
      var c = foldLine(l.t, o);
      if (l.cr && !o.ignoreLineEndings && !moved) c += "\r";
      return { t: l.t, c: c, n: l.n, i: idx };
    });
  }

  function opsFromParts(parts) {
    var ops = [], i = 0, aPos = 0, bPos = 0, len, p, nx;
    while (i < parts.length) {
      p = parts[i];
      len = p.value.length;
      if (p.removed && i + 1 < parts.length && parts[i + 1].added) {
        nx = parts[i + 1];
        ops.push({ k: "rep", a0: aPos, a1: aPos + len, b0: bPos, b1: bPos + nx.value.length });
        aPos += len; bPos += nx.value.length; i += 2;
      } else if (p.removed) {
        ops.push({ k: "rm", a0: aPos, a1: aPos + len, b0: bPos, b1: bPos });
        aPos += len; i += 1;
      } else if (p.added) {
        ops.push({ k: "add", a0: aPos, a1: aPos, b0: bPos, b1: bPos + len });
        bPos += len; i += 1;
      } else {
        ops.push({ k: "eq", a0: aPos, a1: aPos + len, b0: bPos, b1: bPos + len });
        aPos += len; bPos += len; i += 1;
      }
    }
    return ops;
  }

  function buildRowsFromOps(ops, aLines, bLines) {
    var rows = [], i, j, op;
    for (i = 0; i < ops.length; i++) {
      op = ops[i];
      if (op.k === "eq") {
        for (j = op.a0; j < op.a1; j++) rows.push({ k: "eq", a: aLines[j], b: bLines[op.b0 + (j - op.a0)] });
      } else if (op.k === "rm") {
        for (j = op.a0; j < op.a1; j++) rows.push({ k: "rm", a: aLines[j], b: null });
      } else if (op.k === "add") {
        for (j = op.b0; j < op.b1; j++) rows.push({ k: "add", a: null, b: bLines[j] });
      } else {
        var na = op.a1 - op.a0, nb = op.b1 - op.b0, n = Math.min(na, nb);
        for (j = 0; j < n; j++) rows.push({ k: "rep", a: aLines[op.a0 + j], b: bLines[op.b0 + j] });
        for (j = n; j < na; j++) rows.push({ k: "rm", a: aLines[op.a0 + j], b: null });
        for (j = n; j < nb; j++) rows.push({ k: "add", a: null, b: bLines[op.b0 + j] });
      }
    }
    return rows;
  }

  function compareLines(aLines, bLines) {
    var aC = aLines.map(function (l) { return l.c; });
    var bC = bLines.map(function (l) { return l.c; });
    function runMain() {
      return Promise.resolve().then(function () {
        return buildRowsFromOps(opsFromParts(Diff.diffArrays(aC, bC)), aLines, bLines);
      });
    }
    if (!worker || aC.length + bC.length <= 600) return runMain();
    return new Promise(function (resolve, reject) {
      var id = ++msgSeq;
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) {
          settled = true;
          delete pendingWorker[id];
          reject(new Error("worker timeout"));
        }
      }, 15000);
      function done(err, rows) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(rows);
      }
      pendingWorker[id] = function (res) {
        try {
          if (res.error) done(new Error("worker failed"));
          else done(null, buildRowsFromOps(res.ops, aLines, bLines));
        } catch (e2) {
          done(e2);
        }
      };
      try {
        worker.postMessage({ id: id, a: aC, b: bC });
      } catch (e3) {
        done(e3);
      }
    }).catch(function () {
      return runMain();
    });
  }

  function needHL() {
    var o = state.opts;
    return !(o.transformSort || o.transformBreaks || o.transformTrim || o.transformLower);
  }

  function hlKey() {
    return state.lang === "plaintext" || !needHL() ? "plain" : state.lang;
  }

  function plainSegs(codeText, count) {
    var segs = [], i, start = 0, end;
    for (i = 0; i < count; i++) {
      end = codeText.indexOf("\n", start);
      end = end === -1 ? codeText.length : end;
      segs.push([{ t: codeText.slice(start, end) }]);
      start = end + 1;
    }
    return segs;
  }

  function tokenLines(html, count, codeText) {
    var wrapper = document.createElement("div");
    wrapper.innerHTML = html;
    var segs = [], i;
    for (i = 0; i < count; i++) segs.push([]);
    var starts = [0];
    for (i = 0; i < codeText.length; i++) if (codeText.charAt(i) === "\n") starts.push(i + 1);
    var lineIdx = 0, off = 0;
    function push(seg) {
      while (seg.t.length && lineIdx < count) {
        var lineEnd = lineIdx + 1 < starts.length ? starts[lineIdx + 1] : codeText.length;
        var room = lineEnd - off;
        if (room <= 0) { lineIdx++; continue; }
        var take = Math.min(room, seg.t.length);
        segs[lineIdx].push({ t: seg.t.slice(0, take), c: seg.c });
        seg = { t: seg.t.slice(take), c: seg.c };
        off += take;
        if (off >= lineEnd) lineIdx++;
      }
    }
    function walk(node, cls) {
      var i2, cn;
      if (node.nodeType === 3) {
        if (node.textContent) push({ t: node.textContent, c: cls });
      } else if (node.nodeType === 1) {
        cn = typeof node.className === "string" ? node.className : (node.className && node.className.baseVal) || "";
        cn = (cn + " " + cls).replace(/\s+/g, " ").trim();
        for (i2 = 0; i2 < node.childNodes.length; i2++) walk(node.childNodes[i2], cn);
      }
    }
    walk(wrapper, "");
    return segs;
  }

  function computeSegs(codeText, count) {
    if (hlKey() === "plain") return Promise.resolve(plainSegs(codeText, count));
    var prep = state.lang === "auto" ? ensureAuto() : ensureLang(state.lang);
    return prep.then(function (grammar) {
      if (!grammar) return plainSegs(codeText, count);
      try {
        var r = state.lang === "auto"
          ? hljs.highlightAuto(codeText)
          : hljs.highlight(codeText, { language: grammar, ignoreIllegals: true });
        return tokenLines(r.value, count, codeText);
      } catch (e) {
        return plainSegs(codeText, count);
      }
    });
  }

  function diffRuns(a, b, charMode) {
    var parts = charMode ? Diff.diffChars(a, b) : Diff.diffWordsWithSpace(a, b);
    var ar = [], br = [], i, p, len, posA = 0, posB = 0;
    for (i = 0; i < parts.length; i++) {
      p = parts[i];
      len = p.value.length;
      if (p.removed) {
        ar.push({ s: posA, e: posA + len });
        posA += len;
      } else if (p.added) {
        br.push({ s: posB, e: posB + len });
        posB += len;
      } else {
        posA += len;
        posB += len;
      }
    }
    if (state.opts.ignoreWhitespace) {
      var fa = [], fb = [], k;
      for (k = 0; k < Math.min(ar.length, br.length); k++) {
        var ta = a.slice(ar[k].s, ar[k].e), tb = b.slice(br[k].s, br[k].e);
        if (!(WS_RE.test(ta) && WS_RE.test(tb))) { fa.push(ar[k]); fb.push(br[k]); }
      }
      return { ar: fa, br: fb };
    }
    return { ar: ar, br: br };
  }

  function marksForPair(aLine, bLine) {
    var useCanon = !state.opts.ignoreWhitespace &&
      aLine.c.length === aLine.t.length && bLine.c.length === bLine.t.length;
    var ta = useCanon ? aLine.c : aLine.t;
    var tb = useCanon ? bLine.c : bLine.t;
    var la = ta.length, lb = tb.length, mode = "word", ws, q, k, changed;
    if (state.precision === "char") mode = "char";
    else if (state.precision === "smart" && la + lb > 0 && Math.max(la, lb) <= 600) {
      ws = /\s/.test(ta) || /\s/.test(tb);
      if (!ws) mode = "char";
      else if (Math.max(la, lb) <= 80) {
        q = diffRuns(ta, tb, true);
        changed = 0;
        for (k = 0; k < q.ar.length; k++) changed += q.ar[k].e - q.ar[k].s;
        for (k = 0; k < q.br.length; k++) changed += q.br[k].e - q.br[k].s;
        mode = changed <= 4 || changed * 6 <= la + lb ? "char" : "word";
      }
    }
    return diffRuns(ta, tb, mode === "char");
  }

  function segToHtml(text, segs, marks, kind) {
    if (!segs || !segs.length) return "";
    var i, out = "";
    var hasMarks = marks && marks.length;
    if (!hasMarks) {
      for (i = 0; i < segs.length; i++) {
        out += segs[i].c ? '<span class="' + esc(segs[i].c) + '">' + esc(segs[i].t) + "</span>" : esc(segs[i].t);
      }
      return out;
    }
    var bounds = [0];
    var pos = 0;
    for (i = 0; i < segs.length; i++) {
      pos += segs[i].t.length;
      bounds.push(pos);
    }
    for (i = 0; i < marks.length; i++) { bounds.push(marks[i].s); bounds.push(marks[i].e); }
    bounds.sort(function (x, y) { return x - y; });
    var uniq = [bounds[0]];
    for (i = 1; i < bounds.length; i++) if (bounds[i] !== bounds[i - 1]) uniq.push(bounds[i]);
    bounds = uniq;
    var mi = 0;
    for (i = 0; i < marks.length; i++) if (marks[i].e <= bounds[0]) mi = i + 1; else break;
    var si = 0, segStart = 0, segEnd = segs[0].t.length, s, e, cls, text2;
    function advanceSeg(to) {
      while (si < segs.length && to >= segEnd) {
        segStart = segEnd;
        si++;
        segEnd = si < segs.length ? segStart + segs[si].t.length : segStart;
      }
    }
    function advanceMark(to) {
      while (mi < marks.length && to >= marks[mi].e) mi++;
    }
    for (i = 0; i < bounds.length - 1; i++) {
      s = bounds[i];
      e = bounds[i + 1];
      if (e <= s) continue;
      advanceSeg(s);
      advanceMark(s);
      text2 = esc(text.slice(s, e));
      cls = si < segs.length && segs[si].c ? ' class="' + esc(segs[si].c) + '"' : "";
      var chunk = cls ? "<span" + cls + ">" + text2 + "</span>" : text2;
      if (mi < marks.length && s >= marks[mi].s && e <= marks[mi].e) {
        out += '<span class="' + kind + '">' + chunk + "</span>";
      } else {
        out += chunk;
      }
    }
    return out;
  }

  function lineHtml(line, segs, marks, kind) {
    return segToHtml(line.t, segs, marks, kind);
  }

  function segsFor(line, h) {
    return line ? h[line.i] || [] : [];
  }

  function renderRow(row, hA, hB) {
    var segA = segsFor(row.a, hA);
    var segB = segsFor(row.b, hB);
    var numL = row.a && row.a.n ? row.a.n : "";
    var numR = row.b && row.b.n ? row.b.n : "";
    var contentL, contentR;
    if (row.k === "eq") {
      contentL = lineHtml(row.a, segA, null, null);
      contentR = lineHtml(row.b, segB, null, null);
      return '<div class="row eq"><div class="num l">' + numL + '</div><div class="cell l">' + contentL +
        '</div><div class="num r">' + numR + '</div><div class="cell r">' + contentR + "</div></div>";
    }
    if (row.k === "rm") {
      return '<div class="row rm"><div class="num l">' + numL + '</div><div class="cell l">' +
        lineHtml(row.a, segA, null, null) + '</div><div class="num r">' + numR + '</div><div class="cell r"></div></div>';
    }
    if (row.k === "add") {
      return '<div class="row add"><div class="num l">' + numL + '</div><div class="cell l"></div><div class="num r">' +
        numR + '</div><div class="cell r">' + lineHtml(row.b, segB, null, null) + "</div></div>";
    }
    var m = marksForPair(row.a, row.b);
    return '<div class="row rep"><div class="num l">' + numL + '</div><div class="cell l">' +
      lineHtml(row.a, segA, m.ar.length ? m.ar : null, "tk-rm") + '</div><div class="num r">' + numR +
      '</div><div class="cell r">' + lineHtml(row.b, segB, m.br.length ? m.br : null, "tk-add") + "</div></div>";
  }

  function renderUrow(row, hA, hB) {
    var segA = segsFor(row.a, hA);
    var segB = segsFor(row.b, hB);
    var numL = row.a && row.a.n ? row.a.n : "";
    var numR = row.b && row.b.n ? row.b.n : "";
    if (row.k === "eq") {
      return '<div class="urow u-eq"><div class="sig"></div><div class="unum">' + numL + '</div><div class="ucell">' +
        lineHtml(row.a, segA, null, null) + "</div></div>";
    }
    if (row.k === "rm") {
      return '<div class="urow u-del"><div class="sig">\u2212</div><div class="unum">' + numL +
        '</div><div class="ucell">' + lineHtml(row.a, segA, null, null) + "</div></div>";
    }
    if (row.k === "add") {
      return '<div class="urow u-add"><div class="sig">+</div><div class="unum">' + numR +
        '</div><div class="ucell">' + lineHtml(row.b, segB, null, null) + "</div></div>";
    }
    var m = marksForPair(row.a, row.b);
    return '<div class="urow u-del"><div class="sig">\u2212</div><div class="unum">' + numL +
      '</div><div class="ucell">' + lineHtml(row.a, segA, m.ar.length ? m.ar : null, "tk-rm") + "</div></div>" +
      '<div class="urow u-add"><div class="sig">+</div><div class="unum">' + numR +
      '</div><div class="ucell">' + lineHtml(row.b, segB, m.br.length ? m.br : null, "tk-add") + "</div></div>";
  }

  function rowHTML(row, hA, hB) {
    return state.view === "unified" ? renderUrow(row, hA, hB) : renderRow(row, hA, hB);
  }

  function planItems(rows) {
    var plan = [], i = 0, j;
    while (i < rows.length) {
      if (rows[i].k === "eq") {
        j = i;
        while (j < rows.length && rows[j].k === "eq") j++;
        plan.push({ eq: true, start: i, rows: rows.slice(i, j) });
        i = j;
      } else {
        j = i;
        while (j < rows.length && rows[j].k !== "eq") j++;
        plan.push({ eq: false, start: i, rows: rows.slice(i, j) });
        i = j;
      }
    }
    return plan;
  }

  var CHUNK = 800;

  function domify(html) {
    var tpl = document.createElement("div");
    tpl.innerHTML = html;
    var frag = document.createDocumentFragment();
    while (tpl.firstChild) frag.appendChild(tpl.firstChild);
    return frag;
  }

  function renderView() {
    if (!cmp) return;
    var token = ++renderToken;
    ELS.diffBody.textContent = "";
    ELS.diffBody.classList.toggle("no-wrap", !state.wrap);
    ELS.diffBody.classList.toggle("unified-view", state.view === "unified");
    var unified = state.view === "unified";
    if (cmp.degenerate) {
      ELS.diffBody.style.removeProperty("--cw-l");
      ELS.diffBody.style.removeProperty("--cw-r");
      ELS.diffBody.style.removeProperty("--cw-u");
      return;
    }
    var plan = planItems(cmp.rows);
    var lastNode = null;
    function append(node) {
      if (lastNode && lastNode.parentNode === ELS.diffBody) lastNode.after(node);
      else ELS.diffBody.appendChild(node);
      lastNode = node;
    }
    function appendRowsChunked(parent, rows, from, cb) {
      if (token !== renderToken) { cb(); return; }
      var to = Math.min(from + CHUNK, rows.length);
      var buf = "";
      for (var i = from; i < to; i++) buf += rowHTML(rows[i], cmp.hA, cmp.hB);
      parent.appendChild(domify(buf));
      if (to < rows.length) setTimeout(function () { appendRowsChunked(parent, rows, to, cb); }, 0);
      else cb();
    }
    function makeBar(item) {
      var bar = document.createElement("div");
      bar.className = unified ? "u-gap-bar" : "gap-bar";
      var key = item.start;
      var open = !!expandedRuns[key];
      var count = item.rows.length;
      var label = count + " unchanged " + (count === 1 ? "line" : "lines");
      bar.innerHTML = '<div class="gap"><button type="button" class="gap-btn">' +
        (open ? "Hide " : "Show ") + esc(label) + "</button></div>";
      var rowsNode = null;
      bar.querySelector(".gap-btn").addEventListener("click", function () {
        if (expandedRuns[key]) {
          delete expandedRuns[key];
          if (rowsNode && rowsNode.parentNode) rowsNode.remove();
          rowsNode = null;
          bar.querySelector(".gap-btn").textContent = "Show " + label;
        } else {
          expandedRuns[key] = 1;
          bar.querySelector(".gap-btn").textContent = "Hide " + label;
          rowsNode = document.createElement("div");
          rowsNode.className = "run-rows";
          append(rowsNode);
          appendRowsChunked(rowsNode, item.rows, 0, function () {});
        }
      });
      return { bar: bar, open: open };
    }
    function step(idx) {
      if (token !== renderToken) return;
      if (idx >= plan.length) { finish(); return; }
      var item = plan[idx];
      var container;
      if (item.eq && state.hideUnchanged) {
        var mk = makeBar(item);
        append(mk.bar);
        if (mk.open) {
          container = document.createElement("div");
          container.className = "run-rows";
          append(container);
          appendRowsChunked(container, item.rows, 0, function () { setTimeout(function () { step(idx + 1); }, 0); });
        } else {
          setTimeout(function () { step(idx + 1); }, 0);
        }
      } else {
        container = document.createElement("div");
        append(container);
        appendRowsChunked(container, item.rows, 0, function () { setTimeout(function () { step(idx + 1); }, 0); });
      }
    }
    function finish() {
      if (token !== renderToken) return;
      computeWrapCols();
    }
    if (plan.length) step(0);
    else finish();
  }

  function measureCharW() {
    var probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;";
    probe.className = "cell";
    probe.textContent = new Array(101).join("M");
    ELS.diffBody.appendChild(probe);
    var w = probe.getBoundingClientRect().width / 100;
    probe.remove();
    return w || 7.5;
  }

  function computeWrapCols() {
    var rows = cmp.rows;
    if (!rows.length) return;
    var wA = 1, wB = 1, i;
    for (i = 0; i < rows.length; i++) {
      if (rows[i].a) wA = Math.max(wA, rows[i].a.t.length);
      if (rows[i].b) wB = Math.max(wB, rows[i].b.t.length);
    }
    var cw = measureCharW();
    ELS.diffBody.style.setProperty("--cw-l", (wA * cw + 24).toFixed(1) + "px");
    ELS.diffBody.style.setProperty("--cw-r", (wB * cw + 24).toFixed(1) + "px");
    ELS.diffBody.style.setProperty("--cw-u", (Math.max(wA, wB) * cw + 24).toFixed(1) + "px");
  }

  function formatStats() {
    var adds = 0, dels = 0, i, r, same = true, k = cmp ? cmp.rows.length : 0;
    for (i = 0; i < k; i++) {
      r = cmp.rows[i];
      if (r.k === "rm" || r.k === "rep") dels++;
      if (r.k === "add" || r.k === "rep") adds++;
      if (r.k !== "eq") same = false;
    }
    ELS.statAdd.hidden = !adds;
    ELS.statDel.hidden = !dels;
    ELS.statSame.hidden = adds > 0 || dels > 0;
    ELS.legendChip.hidden = adds === 0 && dels === 0;
    if (adds) ELS.statAdd.textContent = "+" + adds + " added";
    if (dels) ELS.statDel.textContent = "\u2212" + dels + " removed";
    if (same && !cmp.degenerate) {
      var n = 0;
      for (i = 0; i < k; i++) if (cmp.rows[i].a) n++;
      ELS.statSame.textContent = n + " line" + (n === 1 ? "" : "s") + " unchanged \u2014 the texts are identical";
    }
    if (cmp.degenerate) ELS.statSame.textContent = "Both texts are empty";
  }

  function setFileNames() {
    ELS.rfnLeft.textContent = meta.left ? meta.left.name + " \u00b7 " + fmtBytes(meta.left.size) : "pasted text";
    ELS.rfnRight.textContent = meta.right ? meta.right.name + " \u00b7 " + fmtBytes(meta.right.size) : "pasted text";
  }

  function revealResults() {
    ELS.comparePlaceholder.hidden = true;
    ELS.resultToolbar.hidden = false;
    ELS.resultFiles.hidden = false;
    setFileNames();
  }

  function resetResults() {
    seqToken++;
    renderToken++;
    state.comparing = false;
    state.compared = false;
    cmp = null;
    expandedRuns = {};
    ELS.overlay.hidden = true;
    ELS.resultToolbar.hidden = true;
    ELS.resultFiles.hidden = true;
    ELS.comparePlaceholder.hidden = false;
    ELS.dirtyBadge.hidden = true;
    ELS.modeNote.hidden = true;
    ELS.diffBody.textContent = "";
    ELS.diffBody.style.removeProperty("--cw-l");
    ELS.diffBody.style.removeProperty("--cw-r");
    ELS.diffBody.style.removeProperty("--cw-u");
  }

  function clearPane(side) {
    var ta = side === "left" ? ELS.textLeft : ELS.textRight;
    ta.value = "";
    setFileMeta(side, null);
    updateCounters();
    if (ELS.textLeft.value === "" && ELS.textRight.value === "") {
      resetResults();
    } else if (state.compared) {
      ELS.dirtyBadge.hidden = false;
      ELS.dirtyBadge.textContent = "Differences update automatically as you type\u2026";
      scheduleRefresh();
    }
    ta.focus();
  }

  function clearAll() {
    ELS.textLeft.value = "";
    ELS.textRight.value = "";
    setFileMeta("left", null);
    setFileMeta("right", null);
    updateCounters();
    resetResults();
    ELS.textLeft.focus();
  }

  function ensureSegs() {
    if (!cmp) return Promise.resolve();
    var want = hlKey();
    if (cmp.segsKey === want && cmp.hA) return Promise.resolve();
    cmp.segsKey = want;
    if (!cmp.codes) {
      cmp.hA = [];
      cmp.hB = [];
      return Promise.resolve();
    }
    return Promise.all([
      computeSegs(cmp.codes.A, cmp.countA),
      computeSegs(cmp.codes.B, cmp.countB)
    ]).then(function (out) {
      cmp.hA = out[0];
      cmp.hB = out[1];
    });
  }

  function runCompare(opts) {
    if (state.comparing) return;
    state.comparing = true;
    opts = opts || {};
    var mySeq = ++seqToken;
    if (opts.overlay) {
      ELS.overlay.hidden = false;
      ELS.comparingLabel.textContent = "Comparing\u2026";
    }
    var o = state.opts;
    var aLines = buildLines(ELS.textLeft.value, o);
    var bLines = buildLines(ELS.textRight.value, o);
    compareLines(aLines, bLines).then(function (rows) {
      if (mySeq !== seqToken) return;
      cmp = {
        rows: rows,
        degenerate: !rows.length && !aLines.length && !bLines.length,
        codes: {
          A: aLines.map(function (l) { return l.t; }).join("\n"),
          B: bLines.map(function (l) { return l.t; }).join("\n")
        },
        countA: aLines.length,
        countB: bLines.length,
        hA: null,
        hB: null,
        segsKey: null
      };
      expandedRuns = {};
      return ensureSegs().then(function () {
        if (mySeq !== seqToken) return;
        state.comparing = false;
        state.compared = true;
        ELS.dirtyBadge.hidden = true;
        if (opts.overlay) ELS.overlay.hidden = true;
        if (opts.reveal) revealResults();
        renderResults();
      });
    }).catch(function () {
      if (mySeq === seqToken) {
        state.comparing = false;
        if (opts.overlay) {
          ELS.overlay.hidden = true;
          ELS.comparingLabel.textContent = "Compare failed";
          setTimeout(function () { ELS.overlay.hidden = true; }, 1200);
        }
      }
    });
  }

  var scheduleRefresh = debounce(function () {
    if (state.compared) runCompare({});
  }, 350);

  function renderResults() {
    if (!cmp) return;
    var token = ++renderToken;
    formatStats();
    var note = activeModeNote();
    ELS.modeNote.textContent = note ? "Active: " + note : "";
    ELS.modeNote.hidden = !note;
    ensureSegs().then(function () {
      if (token !== renderToken) return;
      renderView();
    });
  }

  function setFile(side, file) {
    var reader = new FileReader();
    reader.onload = function () {
      var ta = side === "left" ? ELS.textLeft : ELS.textRight;
      ta.value = String(reader.result || "");
      setFileMeta(side, file.name, file.size);
      updateCounters();
      if (state.compared) {
        ELS.dirtyBadge.hidden = false;
        ELS.dirtyBadge.textContent = "Files changed \u2014 results update automatically";
        scheduleRefresh();
      }
    };
    reader.readAsText(file);
  }

  /* ---------------- options popover (dual anchor, shared panel) ---------------- */

  var settingsOpen = false;
  var settingsAnchor = null;

  function setPop(open, btn) {
    settingsOpen = open;
    settingsAnchor = open ? btn : null;
    ELS.settingsPanel.hidden = !open;
    ELS.settingsBtns.forEach(function (b) {
      b.setAttribute("aria-expanded", String(open && b === btn));
    });
  }

  function gearClick(btn, wrap) {
    if (settingsOpen && settingsAnchor === btn) {
      setPop(false, btn);
      return;
    }
    if (wrap !== ELS.settingsPanel.parentNode) {
      wrap.appendChild(ELS.settingsPanel);
    }
    setPop(true, btn);
  }

  function wireSettings() {
    ELS.settingsBtns.forEach(function (btn, i) {
      var wrap = i === 0 ? ELS.settingsWrap1 : ELS.settingsWrap2;
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        gearClick(btn, wrap);
      });
    });
    $$("#settingsPanel input[type=checkbox]").forEach(function (b) {
      b.checked = !!state.opts[b.dataset.opt];
      b.addEventListener("change", function () { setOpt(b.dataset.opt, b.checked); });
    });
    ELS.langSel.addEventListener("change", function () {
      state.lang = ELS.langSel.value;
      Store.set("dc-lang", state.lang);
      optionBadge();
      if (cmp) renderResults();
    });
    optionBadge();
    document.addEventListener("click", function (e) {
      if (!settingsOpen) return;
      var inBtn = ELS.settingsBtns.some(function (b) { return b === e.target || b.contains(e.target); });
      var inPanel = ELS.settingsPanel === e.target || ELS.settingsPanel.contains(e.target);
      if (!inBtn && !inPanel) setPop(false, settingsAnchor);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && settingsOpen) setPop(false, settingsAnchor);
    });
  }

  /* ---------------- controls ---------------- */

  function updateToggles() {
    ELS.hideUnchangedBtn.classList.toggle("on", state.hideUnchanged);
    ELS.hideUnchangedBtn.setAttribute("aria-pressed", String(state.hideUnchanged));
    ELS.wrapBtn.classList.toggle("on", state.wrap);
    ELS.wrapBtn.setAttribute("aria-pressed", String(state.wrap));
  }

  function wireSeg(container, prop, storageKey) {
    var btns = container.querySelectorAll("button");
    btns.forEach(function (b) {
      var val = b.dataset.view || b.dataset.precision;
      b.classList.toggle("active", state[prop] === val);
      b.addEventListener("click", function () {
        state[prop] = val;
        Store.set(storageKey, val);
        btns.forEach(function (x) {
          x.classList.toggle("active", x === b);
        });
        if (cmp) renderResults();
      });
    });
  }

  function wireMain() {
    ELS.findBtn.addEventListener("click", function () { runCompare({ overlay: true, reveal: true }); });
    ELS.exampleBtn.addEventListener("click", function () {
      ELS.textLeft.value = '{\n  "orderId": "K1000486",\n  "skuCount": 4,\n  "discount": 20.00,\n  "shipping": 1.11,\n  "subtotal": 21.11,\n  "paid": false\n}';
      ELS.textRight.value = '{\n  "orderId": "K1000486",\n  "skuCount": 4,\n  "discount": 20.00,\n  "shipping": 3.56,\n  "subtotal": 23.56,\n  "paid": true\n}';
      updateCounters();
      runCompare({ overlay: true, reveal: true });
    });

    [ELS.textLeft, ELS.textRight].forEach(function (ta) {
      ta.addEventListener("input", function () {
        updateCounters();
        if (state.compared) {
          ELS.dirtyBadge.hidden = false;
          ELS.dirtyBadge.textContent = "Differences update automatically as you type\u2026";
          scheduleRefresh();
        }
      });
      ta.addEventListener("keydown", function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          runCompare({ overlay: true, reveal: true });
        }
      });
    });

    ELS.themeToggle.addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      Store.set("dc-theme", next);
    });

    wireSeg($("#viewSeg"), "view", "dc-view");
    wireSeg($("#precisionSeg"), "precision", "dc-precision");

    ELS.hideUnchangedBtn.addEventListener("click", function () {
      state.hideUnchanged = !state.hideUnchanged;
      Store.set("dc-hide", state.hideUnchanged);
      updateToggles();
      expandedRuns = {};
      if (cmp) renderResults();
    });

    ELS.wrapBtn.addEventListener("click", function () {
      state.wrap = !state.wrap;
      Store.set("dc-wrap", state.wrap);
      updateToggles();
      if (cmp) renderResults();
    });

    $$(".file-btn").forEach(function (b) {
      b.addEventListener("click", function () {
        ELS.fileInput.dataset.side = b.dataset.pane;
        ELS.fileInput.click();
      });
    });

    ELS.fileInput.addEventListener("change", function () {
      var f = ELS.fileInput.files && ELS.fileInput.files[0];
      if (f) setFile(ELS.fileInput.dataset.side === "right" ? "right" : "left", f);
      ELS.fileInput.value = "";
    });

    ELS.clearBtns.left.addEventListener("click", function () { clearPane("left"); });
    ELS.clearBtns.right.addEventListener("click", function () { clearPane("right"); });
    ELS.clearAllBtn.addEventListener("click", clearAll);

    wireDragDrop();
  }

  /* ---------------- drag and drop ---------------- */

  function wireDragDrop() {
    var depth = 0;
    var overSide = null;
    var zones = $$(".drop-zone");
    function hasFiles(e) {
      var dt = e.dataTransfer;
      return dt && dt.types && Array.prototype.indexOf.call(dt.types, "Files") !== -1;
    }
    function setOver(side) {
      overSide = side;
      $$(".pane").forEach(function (p) {
        p.classList.toggle("is-dragging", p.dataset.drop === side);
      });
      zones.forEach(function (z) { z.hidden = z.dataset.drop !== side; });
    }
    function clearOver() {
      overSide = null;
      $$(".pane").forEach(function (p) { p.classList.remove("is-dragging"); });
      zones.forEach(function (z) { z.hidden = true; });
    }
    document.addEventListener("dragenter", function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      ELS.dropVeil.hidden = false;
      var pane = e.target && e.target.closest ? e.target.closest(".pane") : null;
      if (pane && pane.dataset.drop) setOver(pane.dataset.drop);
    });
    document.addEventListener("dragover", function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      var pane = e.target && e.target.closest ? e.target.closest(".pane") : null;
      if (pane && pane.dataset.drop) {
        if (pane.dataset.drop !== overSide) setOver(pane.dataset.drop);
      } else if (overSide) {
        clearOver();
      }
    });
    document.addEventListener("dragleave", function (e) {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        ELS.dropVeil.hidden = true;
        clearOver();
      }
    });
    document.addEventListener("drop", function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      ELS.dropVeil.hidden = true;
      var pane = e.target && e.target.closest ? e.target.closest(".pane") : null;
      var side = pane && pane.dataset.drop ? pane.dataset.drop : (overSide || (e.clientX < window.innerWidth / 2 ? "left" : "right"));
      clearOver();
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) setFile(side, f);
    });
  }

  /* ---------------- init ---------------- */

  function initControls() {
    ELS.langSel.value = state.lang;
    updateToggles();
  }

  function init() {
    var theme = document.documentElement.getAttribute("data-theme") || "dark";
    document.documentElement.setAttribute("data-theme", theme);
    initControls();
    updateCounters();
  }

  wireSettings();
  wireMain();
  init();
})();
