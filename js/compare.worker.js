"use strict";

importScripts("./vendor/diff.min.js");

self.addEventListener("message", function (evt) {
  var data = evt.data || {};
  var id = data.id;
  var a = data.a || [];
  var b = data.b || [];
  var parts;
  try {
    parts = Diff.diffArrays(a, b);
  } catch (err) {
    self.postMessage({ id: id, error: String(err && err.message || err) });
    return;
  }
  var ops = [];
  var idx = 0;
  var aPos = 0;
  var bPos = 0;
  while (idx < parts.length) {
    var p = parts[idx];
    var na = p.value.length;
    var nb = p.value.length;
    if (p.removed && idx + 1 < parts.length && parts[idx + 1].added) {
      var nxt = parts[idx + 1];
      ops.push({ k: "rep", a0: aPos, a1: aPos + na, b0: bPos, b1: bPos + nxt.value.length });
      aPos += na;
      bPos += nxt.value.length;
      idx += 2;
    } else if (p.removed) {
      ops.push({ k: "rm", a0: aPos, a1: aPos + na, b0: bPos, b1: bPos });
      aPos += na;
      idx += 1;
    } else if (p.added) {
      ops.push({ k: "add", a0: aPos, a1: aPos, b0: bPos, b1: bPos + nb });
      bPos += nb;
      idx += 1;
    } else {
      ops.push({ k: "eq", a0: aPos, a1: aPos + na, b0: bPos, b1: bPos + nb });
      aPos += na;
      bPos += nb;
      idx += 1;
    }
  }
  self.postMessage({ id: id, ops: ops, a: aPos, b: bPos });
});
