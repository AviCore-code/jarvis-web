/* JARVIS Web conversation utilities.
 * The media, network, VAD, TTS and UI controller lives in index.html.
 * Keep this file side-effect free so the page has exactly one controller.
 */
(function attachJarvisConversationUtilities(global) {
  'use strict';

  // Do not use \b after Thai text: JavaScript word boundaries are
  // ASCII-oriented and would make Thai wake phrases impossible to match.
  var WAKE_RE = /^(?:hey\s+)?(?:jarvis\b|จาร์วิส|จาวิส)[\s,:-]*/i;
  var END_RE = /^(?:bye|goodbye|ลาก่อน|จบการสนทนา|หยุดฟัง)[.!?\s]*$/i;

  function cleanUtterance(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function findWakePhrase(text) {
    var cleaned = cleanUtterance(text);
    var match = cleaned.match(WAKE_RE);
    return match ? match[0].trim() : '';
  }

  function createConversationMode() {
    var active = false;
    return {
      activate: function activate() { active = true; },
      deactivate: function deactivate() { active = false; },
      isActive: function isActive() { return active; },
    };
  }

  function routeVoiceTranscript(mode, text, handlers) {
    var cleaned = cleanUtterance(text);
    var actions = handlers || {};
    if (!cleaned) return { action: 'ignore', text: '' };

    if (END_RE.test(cleaned)) {
      if (mode && typeof mode.deactivate === 'function') mode.deactivate();
      var endReply = 'จบการสนทนาแล้วครับ เรียกผมได้เสมอครับ';
      if (typeof actions.localReply === 'function') actions.localReply(endReply, 'end');
      return { action: 'end', text: cleaned, reply: endReply };
    }

    var wake = findWakePhrase(cleaned);
    if (!mode || typeof mode.isActive !== 'function') {
      if (typeof actions.submit === 'function') actions.submit(cleaned);
      return { action: 'submit', text: cleaned };
    }

    if (!mode.isActive()) {
      if (!wake) return { action: 'ignore', text: cleaned };
      mode.activate();
      cleaned = cleanUtterance(cleaned.replace(WAKE_RE, ''));
      if (!cleaned) {
        var readyReply = 'พร้อมฟังครับ';
        if (typeof actions.localReply === 'function') actions.localReply(readyReply, 'ready');
        return { action: 'ready', text: '', reply: readyReply };
      }
    } else if (wake) {
      cleaned = cleanUtterance(cleaned.replace(WAKE_RE, ''));
      if (!cleaned) return { action: 'ignore', text: '' };
    }

    if (typeof actions.submit === 'function') actions.submit(cleaned);
    return { action: 'submit', text: cleaned };
  }

  global.cleanUtterance = cleanUtterance;
  global.findWakePhrase = findWakePhrase;
  global.createConversationMode = createConversationMode;
  global.routeVoiceTranscript = routeVoiceTranscript;
})(typeof window !== 'undefined' ? window : globalThis);
