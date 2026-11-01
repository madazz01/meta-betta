// Scroll following: new output follows the view only while the user is
// already at the bottom (or just sent a message). Shared: the webview loads
// it as a plain script, and the node tests require it.
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.MetaBettaScroll = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // How close to the bottom counts as "reading the latest".
  var FOLLOW_PX = 60;

  // Pixels between the view and the bottom, from the scroller's metrics.
  function distanceFromBottom(scrollHeight, scrollTop, clientHeight) {
    return scrollHeight - scrollTop - clientHeight;
  }

  // Follow new output when the user is at the bottom, or just sent something
  // (sending always jumps back to the bottom).
  function shouldFollow(distance, justSent) {
    return justSent === true || distance <= FOLLOW_PX;
  }

  return {
    FOLLOW_PX: FOLLOW_PX,
    distanceFromBottom: distanceFromBottom,
    shouldFollow: shouldFollow,
  };
});
