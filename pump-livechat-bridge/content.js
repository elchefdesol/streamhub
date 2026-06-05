(function streamHubPumpLivechatBridge() {
  const ENDPOINTS = [
    "http://127.0.0.1:3000/pump/livechat/push",
    "http://localhost:3000/pump/livechat/push"
  ];
  const seenIds = new Map();
  const pending = new WeakSet();
  const badgeWords = new Set(["owner", "dev", "creator", "mod", "moderator", "admin", "vip"]);
  const WARMUP_MS = 8000;
  const bridgeStartedAt = Date.now();
  const bridgeStartMinute = new Date(bridgeStartedAt).getHours() * 60 + new Date(bridgeStartedAt).getMinutes();
  let bridgeReady = false;

  if (!location.pathname.startsWith("/livechat/")) {
    console.log("StreamHub Pump.fun bridge ignored this page because it is not a /livechat/ URL.");
    return;
  }

  function clean(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function compactUser(value) {
    return clean(value).replace(/^@/, "").toLowerCase();
  }

  function isNoise(text) {
    const value = clean(text).toLowerCase();
    if (!value) return true;
    if (value.length < 2) return true;
    return [
      "live chat",
      "joining room...",
      "new messages will appear here",
      "read-only mode - log in to send messages",
      "read-only mode",
      "log in to send messages"
    ].includes(value);
  }

  function textParts(row) {
    const text = String(row.innerText || row.textContent || "");
    return text.split(/\n+/).map(clean).filter(Boolean).filter((part) => !isNoise(part));
  }

  function userFromParts(parts) {
    const first = clean(parts[0] || "");
    if (/^[@$]?[A-Za-z0-9_.-]{2,40}:?$/.test(first)) return first.replace(/:$/, "");
    const joined = parts.join(" ");
    const mention = joined.match(/[@$][A-Za-z0-9_.-]{2,40}/);
    return mention ? mention[0] : "Pump user";
  }

  function messageFromParts(parts, user) {
    if (!parts.length) return "";
    const userKey = compactUser(user);
    const rest = parts.slice(user === "Pump user" ? 0 : 1).filter((part) => {
      const value = clean(part);
      const key = compactUser(value);
      if (!value) return false;
      if (key === userKey) return false;
      if (badgeWords.has(value.toLowerCase())) return false;
      return true;
    });
    const joined = rest.join(" ");
    const colon = joined.match(/^([^:]{2,50}):\s*(.+)$/);
    return clean(colon ? colon[2] : joined);
  }

  function stripLeadingBadges(message) {
    let value = clean(message);
    for (let index = 0; index < 3; index += 1) {
      const match = value.match(/^([A-Za-z]{2,16})\s+(.+)$/);
      if (!match || !badgeWords.has(match[1].toLowerCase())) break;
      value = clean(match[2]);
    }
    return value;
  }

  function parsePumpLine(row) {
    const text = clean(row.innerText || row.textContent || "");
    const match = text.match(/^(\d{1,2}):(\d{2})\s+([@$]?[A-Za-z0-9_.-]{2,40})\s+(.+)$/);
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const user = clean(match[3]);
    const message = stripLeadingBadges(match[4]);
    if (!user || !message || isNoise(message)) return null;
    return { user, message, minuteOfDay: hour * 60 + minute };
  }

  function isOlderThanBridge(rowMinute) {
    if (!Number.isFinite(rowMinute)) return false;
    const now = new Date();
    const currentMinute = now.getHours() * 60 + now.getMinutes();
    if (bridgeStartMinute <= currentMinute) return rowMinute < bridgeStartMinute;
    return rowMinute < bridgeStartMinute && rowMinute > currentMinute;
  }

  function remember(id) {
    if (seenIds.has(id)) return false;
    seenIds.set(id, Date.now());
    while (seenIds.size > 5000) {
      seenIds.delete(seenIds.keys().next().value);
    }
    return true;
  }

  function messageId(user, message, bucket = "") {
    return `pump:${compactUser(user)}:${bucket}:${clean(message).toLowerCase()}`;
  }

  function textLength(node) {
    return clean(node && (node.innerText || node.textContent || "")).length;
  }

  function findChatRoots(root = document, allowDocumentFallback = false) {
    const scope = root && root.querySelectorAll ? root : document;
    const selectors = [
      "[role='log']",
      "[aria-label*='chat' i]",
      "[data-testid*='chat' i]",
      "[class*='chat' i]",
      "[class*='messages' i]",
      "[class*='message-list' i]"
    ];
    const roots = new Set();

    selectors.forEach((selector) => {
      scope.querySelectorAll(selector).forEach((node) => {
        if (node === document.documentElement || node === document.body) return;
        const length = textLength(node);
        if (length >= 2 && length <= 5000) roots.add(node);
      });
    });

    if (!roots.size && allowDocumentFallback) {
      const livechat = document.querySelector("main") || document.body;
      if (livechat && textLength(livechat) <= 5000) roots.add(livechat);
    }

    return Array.from(roots).filter((node, index, list) => {
      return !list.some((other, otherIndex) => otherIndex !== index && other.contains(node));
    });
  }

  function isCandidate(node, chatRoot) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = node.tagName.toLowerCase();
    if (["script", "style", "svg", "path", "button", "input", "textarea"].includes(tag)) return false;
    if (node === chatRoot || node === document.body || node === document.documentElement) return false;
    const text = clean(node.innerText || node.textContent || "");
    if (!text || text.length > 360 || isNoise(text)) return false;
    if (parsePumpLine(node)) return true;
    const parts = textParts(node);
    if (parts.length < 2) return false;
    const childTextBlocks = Array.from(node.children || []).filter((child) => textLength(child) > 0);
    const nestedCandidates = childTextBlocks.filter((child) => textParts(child).length >= 2 && textLength(child) < text.length);
    if (nestedCandidates.length > 1) return false;
    return childTextBlocks.length <= 6;
  }

  function candidateRows(root, allowDocumentFallback = false) {
    const scope = root && root.querySelectorAll ? root : document;
    const rows = new Set();
    const selectors = [
      "div.relative.flex.w-full.flex-row.items-start.gap-1.rounded-lg",
      "div[class*='flex-row'][class*='items-start'][class*='rounded-lg'][class*='px-2'][class*='py-2']",
      "[role='listitem']",
      "[data-testid*='message' i]",
      "[class*='message' i]",
      "[class*='chat-message' i]",
      "li",
      "article"
    ];

    if (isCandidate(scope, scope.parentElement || document.body)) rows.add(scope);

    findChatRoots(scope, allowDocumentFallback).forEach((chatRoot) => {
      selectors.forEach((selector) => {
        chatRoot.querySelectorAll(selector).forEach((node) => {
          if (isCandidate(node, chatRoot)) rows.add(node);
        });
      });
    });
    return Array.from(rows);
  }

  function parseRow(row, prime = false) {
    const direct = parsePumpLine(row);
    if (direct) {
      const id = messageId(direct.user, direct.message, direct.minuteOfDay);
      if (prime) {
        seenIds.set(id, Date.now());
        return null;
      }
      if (isOlderThanBridge(direct.minuteOfDay)) {
        seenIds.set(id, Date.now());
        return null;
      }
      if (!remember(id)) return null;
      return {
        source: "pump",
        user: direct.user,
        text: direct.message,
        id: `${id}:${Date.now().toString(36)}`,
        ts: Date.now()
      };
    }

    const parts = textParts(row);
    if (!parts.length) return null;
    const user = userFromParts(parts);
    const message = messageFromParts(parts, user);
    if (!message || isNoise(message) || clean(message) === clean(user)) return null;
    const id = messageId(user, message);
    if (prime) {
      seenIds.set(id, Date.now());
      return null;
    }
    if (!remember(id)) return null;
    return {
      source: "pump",
      user,
      text: message,
      id: `${id}:${Date.now().toString(36)}`,
      ts: Date.now()
    };
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
    if (result) console.log("StreamHub Pump.fun bridge connected.", result);
  }

  async function postMessages(messages) {
    if (!messages.length) return;
    const result = await postPayload({ messages });
    if (result) {
      console.log(`StreamHub Pump.fun bridge sent ${messages.length} message(s).`, result);
    } else {
      console.warn("StreamHub Pump.fun bridge could not reach the local StreamHub server.");
    }
  }

  function scan(root, prime = false, allowDocumentFallback = false) {
    const shouldPrime = prime || !bridgeReady;
    const messages = candidateRows(root, allowDocumentFallback).map((row) => parseRow(row, shouldPrime)).filter(Boolean);
    postMessages(messages);
  }

  function schedule(node) {
    if (!node) return;
    const target = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!target || pending.has(target)) return;
    pending.add(target);
    setTimeout(() => {
      pending.delete(target);
      const row = target.matches?.("div.relative.flex.w-full.flex-row.items-start.gap-1.rounded-lg, div[class*='flex-row'][class*='items-start'][class*='rounded-lg'][class*='px-2'][class*='py-2']")
        ? target
        : target.closest?.("div.relative.flex.w-full.flex-row.items-start.gap-1.rounded-lg, div[class*='flex-row'][class*='items-start'][class*='rounded-lg'][class*='px-2'][class*='py-2']");
      scan(row || target, false, false);
    }, 250);
  }

  if (window.__streamHubPumpObserver) window.__streamHubPumpObserver.disconnect();
  if (window.__streamHubPumpTimer) clearInterval(window.__streamHubPumpTimer);
  if (window.__streamHubPumpHeartbeat) clearInterval(window.__streamHubPumpHeartbeat);
  if (window.__streamHubPumpWarmup) clearTimeout(window.__streamHubPumpWarmup);

  postStatus();
  scan(document, true, true);
  window.__streamHubPumpTimer = setInterval(() => scan(document, !bridgeReady, true), 1000);
  window.__streamHubPumpWarmup = setTimeout(() => {
    scan(document, true, true);
    bridgeReady = true;
    console.log("StreamHub Pump.fun bridge is ready. Only new livechat messages will be sent.");
  }, WARMUP_MS);
  window.__streamHubPumpHeartbeat = setInterval(postStatus, 30000);
  window.__streamHubPumpObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach(schedule);
      if (mutation.type === "characterData") schedule(mutation.target);
    }
  });
  window.__streamHubPumpObserver.observe(document.documentElement, { childList: true, characterData: true, subtree: true });

  console.log("StreamHub Pump.fun Livechat Bridge is running. Reload this Pump.fun tab after updating the extension.");
})();
