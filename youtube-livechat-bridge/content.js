(function streamHubYouTubeLivechatBridge() {
  const ENDPOINTS = [
    "http://127.0.0.1:3000/youtube/livechat/push",
    "http://localhost:3000/youtube/livechat/push"
  ];
  const seen = new Map();
  const pending = new WeakSet();
  const MESSAGE_TTL = 10 * 60 * 1000;
  const MAX_SEEN = 2000;
  const WARMUP_MS = 6500;
  let bridgeReady = false;

  function clean(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function pruneSeen() {
    const cutoff = Date.now() - MESSAGE_TTL;
    for (const [key, ts] of seen) {
      if (ts < cutoff) seen.delete(key);
    }
    while (seen.size > MAX_SEEN) {
      seen.delete(seen.keys().next().value);
    }
  }

  function remember(key) {
    if (!key) return false;
    pruneSeen();
    if (seen.has(key)) {
      seen.set(key, Date.now());
      return false;
    }
    seen.set(key, Date.now());
    return true;
  }

  function textOf(root, selector) {
    return clean(root.querySelector?.(selector)?.innerText || root.querySelector?.(selector)?.textContent || "");
  }

  function isNoise(text) {
    const value = clean(text).toLowerCase();
    if (!value || value.length < 1) return true;
    return [
      "live chat",
      "top chat",
      "all messages are visible",
      "some messages such as potential spam may not be visible",
      "welcome to live chat!",
      "remember to guard your privacy and abide by our community guidelines."
    ].includes(value);
  }

  function rendererKind(row) {
    const tag = row.tagName?.toLowerCase() || "";
    if (tag.includes("paid-message")) return "superchat";
    if (tag.includes("paid-sticker")) return "supersticker";
    if (tag.includes("membership")) return "member";
    return "chat";
  }

  function parseRenderer(row, prime = false) {
    if (!row || row.nodeType !== Node.ELEMENT_NODE) return null;
    const kind = rendererKind(row);
    const idAttr = row.id || row.getAttribute("id") || "";
    const author = textOf(row, "#author-name") || textOf(row, "yt-live-chat-author-chip") || "YouTube user";
    const message = textOf(row, "#message") || textOf(row, "#purchase-amount") || textOf(row, "#header-content-primary-column");
    const badge = kind === "superchat" || kind === "supersticker"
      ? "PAID"
      : kind === "member"
        ? "MEMBER"
        : "";
    const text = kind === "chat"
      ? message
      : clean([message, textOf(row, "#content")].filter(Boolean).join(" "));

    if (!text || isNoise(text) || clean(text) === clean(author)) return null;
    const key = clean(`youtube:${kind}:${author}:${text}`).toLowerCase();
    if (prime) {
      seen.set(key, Date.now());
      return null;
    }
    if (!remember(key)) return null;
    const isActivity = kind !== "chat";
    return {
      source: "youtube",
      id: idAttr ? `youtube:${idAttr}` : `${key}:${Date.now().toString(36)}`,
      user: author,
      text: isActivity && kind === "member" && !/member/i.test(text) ? `${author} became a member` : text,
      badge,
      type: isActivity ? "activity" : "chat",
      event: isActivity ? kind : "",
      overlay: !isActivity,
      ts: Date.now()
    };
  }

  function candidateRows(root = document) {
    const scope = root && root.querySelectorAll ? root : document;
    const rows = new Set();
    const selectors = [
      "yt-live-chat-text-message-renderer",
      "yt-live-chat-paid-message-renderer",
      "yt-live-chat-paid-sticker-renderer",
      "yt-live-chat-membership-item-renderer"
    ];
    if (scope.matches?.(selectors.join(","))) rows.add(scope);
    selectors.forEach((selector) => {
      scope.querySelectorAll(selector).forEach((row) => rows.add(row));
    });
    return Array.from(rows);
  }

  async function postPayload(payload) {
    for (const endpoint of ENDPOINTS) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          mode: "cors",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (response.ok) return response.json().catch(() => ({ ok: true }));
      } catch {
      }
    }
    return null;
  }

  async function postStatus() {
    const result = await postPayload({ type: "bridge-status", url: location.href, ts: Date.now() });
    if (result) console.log("StreamHub YouTube bridge connected.", result);
  }

  async function postMessages(messages) {
    if (!messages.length) return;
    const result = await postPayload({ messages });
    if (result) console.log(`StreamHub YouTube bridge sent ${messages.length} message(s).`, result);
    else console.warn("StreamHub YouTube bridge could not reach the local StreamHub server.");
  }

  function scan(root = document, prime = false) {
    const shouldPrime = prime || !bridgeReady;
    const messages = candidateRows(root).map((row) => parseRenderer(row, shouldPrime)).filter(Boolean);
    postMessages(messages);
  }

  function schedule(node) {
    const target = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    if (!target || pending.has(target)) return;
    pending.add(target);
    setTimeout(() => {
      pending.delete(target);
      scan(target, false);
    }, 200);
  }

  if (window.__streamHubYouTubeObserver) window.__streamHubYouTubeObserver.disconnect();
  if (window.__streamHubYouTubeTimer) clearInterval(window.__streamHubYouTubeTimer);
  if (window.__streamHubYouTubeHeartbeat) clearInterval(window.__streamHubYouTubeHeartbeat);
  if (window.__streamHubYouTubeWarmup) clearTimeout(window.__streamHubYouTubeWarmup);

  postStatus();
  scan(document, true);
  window.__streamHubYouTubeTimer = setInterval(() => scan(document, !bridgeReady), 1200);
  window.__streamHubYouTubeWarmup = setTimeout(() => {
    scan(document, true);
    bridgeReady = true;
    console.log("StreamHub YouTube bridge is ready. Only new live chat messages will be sent.");
  }, WARMUP_MS);
  window.__streamHubYouTubeHeartbeat = setInterval(postStatus, 30000);
  window.__streamHubYouTubeObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach(schedule);
      if (mutation.type === "characterData") schedule(mutation.target);
    }
  });
  window.__streamHubYouTubeObserver.observe(document.documentElement, { childList: true, characterData: true, subtree: true });

  console.log("StreamHub YouTube Livechat Bridge is running. Keep this YouTube chat tab open.");
})();
