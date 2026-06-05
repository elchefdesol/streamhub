(function streamHubXLivechatBridge() {
  const ENDPOINTS = [
    "http://127.0.0.1:3000/x/livechat/push",
    "http://localhost:3000/x/livechat/push"
  ];
  const seen = new Map();
  const pendingRows = new WeakSet();
  const MESSAGE_TTL = 5 * 60 * 1000;
  const MAX_SEEN = 600;

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

  function isNoise(text) {
    const value = clean(text).toLowerCase();
    if (!value) return true;
    if (/^\d{1,2}:\d{2}\s?(am|pm)?$/.test(value)) return true;
    if (/^(reply|repost|like|share|views?|live|verified|send a message)$/.test(value)) return true;
    if (value.includes("this broadcast has ended")) return true;
    return false;
  }

  function avatarFor(node) {
    if (!node || node.nodeType !== 1) return null;
    if (node.matches && node.matches("[data-testid^='UserAvatar-Container-']")) return node;
    return node.querySelector ? node.querySelector("[data-testid^='UserAvatar-Container-']") : null;
  }

  function rowFor(node) {
    const avatar = avatarFor(node);
    if (!avatar) return null;

    let current = avatar;
    let best = null;
    while (current && current !== document.body) {
      const avatarCount = current.querySelectorAll ? current.querySelectorAll("[data-testid^='UserAvatar-Container-']").length : 0;
      const text = clean(current.innerText || current.textContent || "");
      if (avatarCount === 1 && text.length > 2) best = current;
      if (avatarCount > 1) break;
      if (current.matches && current.matches('[data-testid="chatContainer"]')) break;
      current = current.parentElement;
    }
    return best;
  }

  function usernameFrom(row) {
    const avatar = avatarFor(row);
    const avatarId = avatar ? avatar.getAttribute("data-testid") || "" : "";
    if (avatarId.startsWith("UserAvatar-Container-")) {
      return avatarId.replace("UserAvatar-Container-", "").replace(/^@/, "");
    }

    const links = row.querySelectorAll ? row.querySelectorAll("a[href^='/'] span") : [];
    for (const span of links) {
      const text = clean(span.textContent);
      if (text.startsWith("@")) return text.replace(/^@/, "");
    }
    return "";
  }

  function displayNameFrom(row) {
    const links = row.querySelectorAll ? row.querySelectorAll("a[href^='/'] span") : [];
    for (const span of links) {
      const text = clean(span.textContent);
      if (text && !text.startsWith("@") && !isNoise(text)) return text;
    }
    const colored = row.querySelector ? row.querySelector("span[style*='color']") : null;
    return clean(colored ? colored.textContent : "");
  }

  function messageFrom(row, username, displayName) {
    const ignored = new Set([
      clean(username).toLowerCase(),
      clean("@" + username).toLowerCase(),
      clean(displayName).toLowerCase()
    ]);

    const spans = row.querySelectorAll ? Array.from(row.querySelectorAll("span")) : [];
    const candidates = spans
      .filter((span) => !span.closest("a[href^='/']"))
      .filter((span) => !span.closest("[data-testid^='UserAvatar-Container-']"))
      .filter((span) => !span.closest("button"))
      .map((span) => clean(span.innerText || span.textContent || ""))
      .filter((text) => text && !ignored.has(text.toLowerCase()) && !isNoise(text));

    if (candidates.length) {
      return candidates[candidates.length - 1];
    }

    const lines = String(row.innerText || row.textContent || "")
      .split(/\n+/)
      .map(clean)
      .filter((text) => text && !ignored.has(text.toLowerCase()) && !isNoise(text));
    return lines[lines.length - 1] || "";
  }

  function rowBridgeId(row) {
    let id = row.getAttribute("data-streamhub-x-id");
    if (!id) {
      id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      row.setAttribute("data-streamhub-x-id", id);
    }
    return id;
  }

  function rowWasSent(row) {
    return row.__streamHubSkip || row.getAttribute("data-streamhub-x-sent") === "1";
  }

  function markRowSent(row) {
    row.__streamHubSkip = true;
    row.setAttribute("data-streamhub-x-sent", "1");
  }

  function parseRow(row) {
    if (!row || rowWasSent(row)) return null;
    const username = usernameFrom(row);
    const displayName = displayNameFrom(row);
    const message = messageFrom(row, username, displayName);
    const user = username || displayName || "X livechat";
    if (!message || clean(message).length < 2 || clean(message) === clean(user)) return null;

    const id = clean(`x-livechat:${rowBridgeId(row)}:${user}:${message}`);
    if (!remember(id)) return null;
    markRowSent(row);
    return {
      source: "x",
      user: user.startsWith("@") ? user : `@${user}`,
      text: message,
      id,
      ts: Date.now()
    };
  }

  async function postMessages(messages) {
    if (!messages.length) return;
    for (const endpoint of ENDPOINTS) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          mode: "cors",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages })
        });
        if (response.ok) return;
      } catch {
      }
    }
  }

  function rowsFrom(root) {
    const scope = root && root.querySelectorAll ? root : document;
    const rows = new Set();
    scope.querySelectorAll("[data-testid^='UserAvatar-Container-']").forEach((avatar) => {
      const row = rowFor(avatar);
      if (row) rows.add(row);
    });
    return Array.from(rows);
  }

  function scan(root, prime = false) {
    const messages = [];
    for (const row of rowsFrom(root)) {
      if (prime) {
        const username = usernameFrom(row);
        const displayName = displayNameFrom(row);
        const message = messageFrom(row, username, displayName);
        const user = username || displayName || "X livechat";
        if (message) remember(clean(`x-livechat:${rowBridgeId(row)}:${user}:${message}`));
        markRowSent(row);
        continue;
      }
      const parsed = parseRow(row);
      if (parsed) messages.push(parsed);
    }
    postMessages(messages);
  }

  function schedule(node) {
    if (!node || pendingRows.has(node)) return;
    pendingRows.add(node);
    setTimeout(() => {
      pendingRows.delete(node);
      scan(node);
    }, 350);
  }

  if (window.__streamHubXBridgeObserver) {
    window.__streamHubXBridgeObserver.disconnect();
  }

  setTimeout(() => scan(document, true), 700);
  if (window.__streamHubXBridgeTimer) clearInterval(window.__streamHubXBridgeTimer);
  window.__streamHubXBridgeTimer = setInterval(() => scan(document), 1200);
  window.__streamHubXBridgeObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach(schedule);
    }
  });
  window.__streamHubXBridgeObserver.observe(document.documentElement, { childList: true, subtree: true });

  console.log("StreamHub X Livechat Bridge is running. Keep this X chat tab open.");
})();
