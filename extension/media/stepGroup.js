// Step grouping: consecutive tool and thinking rows fold into one muted
// summary line ("▸ Read 8 files · ran 3 commands"). Shared: the webview
// loads it as a plain script, and the node tests require it.
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.MetaBettaSteps = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var BUCKETS = ["read", "command", "edit", "search", "other"];

  // "step" folds into the current group; anything else renders on its own
  // and closes the group.
  function stepClass(type, failed) {
    if (type === "thinking") {
      return "step";
    }
    if (type === "tool") {
      return failed === true ? "solo" : "step";
    }
    return "solo";
  }

  function plural(n, one, many) {
    return n === 1 ? one : many;
  }

  function summarizeSteps(counts) {
    var parts = [];
    if (counts.read > 0) {
      parts.push("read " + counts.read + " " + plural(counts.read, "file", "files"));
    }
    if (counts.command > 0) {
      parts.push("ran " + counts.command + " " + plural(counts.command, "command", "commands"));
    }
    if (counts.edit > 0) {
      parts.push("edited " + counts.edit + " " + plural(counts.edit, "file", "files"));
    }
    if (counts.search > 0) {
      parts.push("searched " + counts.search + " " + plural(counts.search, "time", "times"));
    }
    if (counts.other > 0) {
      parts.push(counts.other + " " + plural(counts.other, "other step", "other steps"));
    }
    if (parts.length === 0) {
      return "▸ Thinking…";
    }
    var line = parts.join(" · ");
    return "▸ " + line.charAt(0).toUpperCase() + line.slice(1);
  }

  // Incremental grouper for the live chat: push each event, get back whether
  // it folds and the current summary. Replays drive the same calls, so a
  // reloaded chat groups exactly like the live one.
  function createGrouper() {
    var open = null;

    function summary() {
      return open ? summarizeSteps(open.counts) : "";
    }

    function bucketFor(group) {
      return BUCKETS.indexOf(group) >= 0 ? group : "other";
    }

    return {
      summary: summary,
      isOpen: function () {
        return open !== null;
      },
      push: function (type, failed, id, group) {
        if (stepClass(type, failed) !== "step") {
          // A grouped row that turned failed moves out on its own; the rest
          // of the group stays open with fixed counts.
          if (
            type === "tool" &&
            failed === true &&
            open &&
            Object.prototype.hasOwnProperty.call(open.buckets, id)
          ) {
            open.counts[open.buckets[id]] -= 1;
            delete open.buckets[id];
            return { action: "solo", summary: summary() };
          }
          open = null;
          return { action: "solo", summary: "" };
        }
        if (!open) {
          open = {
            counts: { read: 0, command: 0, edit: 0, search: 0, other: 0 },
            buckets: {},
          };
        }
        // Rows update in place; each row counts once, however often it paints.
        if (type === "tool" && !Object.prototype.hasOwnProperty.call(open.buckets, id)) {
          var bucket = bucketFor(group);
          open.buckets[id] = bucket;
          open.counts[bucket] += 1;
        }
        return { action: "fold", summary: summary() };
      },
      close: function () {
        open = null;
      },
    };
  }

  return {
    stepClass: stepClass,
    summarizeSteps: summarizeSteps,
    createGrouper: createGrouper,
  };
});
