(function streamHubPumpLivechatBridge() {
  const ENDPOINTS = [
    "http://127.0.0.1:3000/pump/livechat/push",
    "http://localhost:3000/pump/livechat/push"
  ];
  const seenIds = new Map();
  const pending = new WeakSet();
  const badgeWords = new Set(["owner", "dev", "creator", "mod", "moderator", "admin", "vip"]);

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

  function remember(id) {
    const now = Date.now();
    for (const [key, ts] of seenIds) {
      if (now - ts > 15000) seenIds.delete(key);
    }
    if (seenIds.has(id)) return false;
    seenIds.set(id, now);
    return true;
  }

  function messageId(user, message) {
    return `pump:${compactUser(user)}:${clean(message).toLowerCase()}`;
  }

  function isCandidate(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = node.tagName.toLowerCase();
    if (["script", "style", "svg", "path", "button", "input", "textarea"].includes(tag)) return false;
    const text = clean(node.innerText || node.textContent || "");
    if (!text || text.length > 360 || isNoise(text)) return false;
    const parts = textParts(node);
    if (parts.length < 2) return false;
    const childTextBlocks = Array.from(node.children || []).filter((child) => clean(child.innerText || child.textContent || "").length > 0);
    return childTextBlocks.length <= 8;
  }

  function candidateRows(root) {
    const scope = root && root.querySelectorAll ? root : document;
    const rows = new Set();
    const selectors = [
      "[role='listitem']",
      "[data-testid*='chat' i]",
      "[data-testid*='message' i]",
      "[class*='chat' i]",
      "[class*='message' i]",
      "li",
      "article",
      "div"
    ];

    if (isCandidate(scope)) rows.add(scope);
    selectors.forEach((selector) => {
      scope.querySelectorAll(selector).forEach((node) => {
        if (isCandidate(node)) rows.add(node);
      });
    });
    return Array.from(rows);
  }

  function parseRow(row, prime = false) {
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

  function scan(root, prime = false) {
    const messages = candidateRows(root).map((row) => parseRow(row, prime)).filter(Boolean);
    postMessages(messages);
  }

  function schedule(node) {
    if (!node) return;
    const target = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!target || pending.has(target)) return;
    pending.add(target);
    setTimeout(() => {
      pending.delete(target);
      scan(target);
    }, 250);
  }

  if (window.__streamHubPumpObserver) window.__streamHubPumpObserver.disconnect();
  if (window.__streamHubPumpTimer) clearInterval(window.__streamHubPumpTimer);
  if (window.__streamHubPumpHeartbeat) clearInterval(window.__streamHubPumpHeartbeat);

  postStatus();
  setTimeout(() => scan(document, true), 800);
  window.__streamHubPumpTimer = setInterval(() => scan(document), 1000);
  window.__streamHubPumpHeartbeat = setInterval(postStatus, 5000);
  window.__streamHubPumpObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach(schedule);
      if (mutation.type === "characterData") schedule(mutation.target);
    }
  });
  window.__streamHubPumpObserver.observe(document.documentElement, { childList: true, characterData: true, subtree: true });

  console.log("StreamHub Pump.fun Livechat Bridge is running. Reload this Pump.fun tab after updating the extension.");
})();
