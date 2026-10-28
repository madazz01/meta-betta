// Tiny markdown renderer for chat replies: fenced code blocks, inline code,
// bold, links, and lists. Everything is HTML-escaped first, so replies can
// never inject markup. Shared: the webview loads it as a plain script, and
// the node tests require it.
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.MetaBettaMarkdown = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Stash placeholders use the NUL character, which never appears in chat text.
  var MARK = String.fromCharCode(0);

  function escapeHtml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function escapeAttr(text) {
    return escapeHtml(text).replace(/"/g, "&quot;");
  }

  function renderMarkdown(source) {
    var stash = [];
    var keep = function (html) {
      stash.push(html);
      return MARK + (stash.length - 1) + MARK;
    };

    // Fenced code blocks first; content stays verbatim.
    var text = String(source).replace(/```[^\n]*\n([\s\S]*?)(?:```|$)/g, function (match, code) {
      return keep("<pre><code>" + escapeHtml(code.replace(/\n$/, "")) + "</code></pre>");
    });

    // Inline code.
    text = text.replace(/`([^`\n]+)`/g, function (match, code) {
      return keep("<code>" + escapeHtml(code) + "</code>");
    });

    // Escape everything left, then add structure back.
    text = escapeHtml(text);

    // Bold.
    text = text.replace(/\*\*([^*\n]+)\*\*/g, function (match, inner) {
      return keep("<strong>" + inner + "</strong>");
    });

    // Links. Dangerous schemes render as plain text.
    text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function (match, label, target) {
      if (/^\s*(javascript|data|vbscript):/i.test(target)) {
        return match;
      }
      var href = escapeAttr(target);
      return keep('<a href="' + href + '">' + label + "</a>");
    });

    // Bare URLs become links too.
    text = text.replace(/(^|[\s(])(https?:\/\/[^\s)<]+)/g, function (match, before, url) {
      return before + keep('<a href="' + escapeAttr(url) + '">' + escapeHtml(url) + "</a>");
    });

    // Lists and line breaks, line by line.
    var lines = text.split("\n");
    var out = [];
    var list = null;
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i];
      var kind = null;
      var content = line;
      var item = line.match(/^\s*[-*+]\s+(.*)$/);
      if (item) {
        kind = "ul";
        content = item[1];
      } else {
        item = line.match(/^\s*\d+[.)]\s+(.*)$/);
        if (item) {
          kind = "ol";
          content = item[1];
        }
      }
      if (kind) {
        if (list !== kind) {
          if (list) {
            out.push("</" + list + ">");
          }
          out.push("<" + kind + ">");
          list = kind;
        }
        out.push("<li>" + content + "</li>");
      } else {
        if (list) {
          out.push("</" + list + ">");
          list = null;
        }
        out.push(content);
      }
    }
    if (list) {
      out.push("</" + list + ">");
    }
    text = out.join("<br>");
    text = text.replace(/<br>(<\/?(?:ul|ol|li)>)/g, "$1").replace(/(<\/?(?:ul|ol|li)>)<br>/g, "$1");

    // Restore stashed HTML; nested stashes resolve iteratively.
    var pattern = new RegExp(MARK + "(\\d+)" + MARK, "g");
    for (var round = 0; round < 10 && text.indexOf(MARK) !== -1; round += 1) {
      text = text.replace(pattern, function (m, index) {
        return stash[Number(index)] || "";
      });
    }
    text = text.replace(/<br>(<pre>)/g, "$1").replace(/(<\/pre>)<br>/g, "$1");
    return text;
  }

  return { renderMarkdown: renderMarkdown };
});
