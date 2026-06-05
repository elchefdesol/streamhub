# StreamHub Pump.fun Livechat Bridge

Experimental Chrome/Edge/Brave extension for Pump.fun livechat.

This reads visible chat messages from a Pump.fun livechat page and sends them to your local StreamHub server:

```text
http://127.0.0.1:3000/pump/livechat/push
```

## Install

1. Open `chrome://extensions/`.
2. Turn on `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder: `pump-livechat-bridge`.

## Use

1. Start StreamHub with `npm start`.
2. Open StreamHub at `http://127.0.0.1:3000`.
3. Paste a Pump.fun livechat URL in the Pump.fun card.
4. Click `Connect Pump.fun Bridge`.
5. Open the Pump livechat page and keep it open while streaming.

Example:

```text
https://pump.fun/livechat/3VkUe5T9uAuU6EqmEMqQcuTRqEcqU86NAfwbFZKxpump
```

## Notes

- This bridge depends on Pump.fun's current web page structure and may need updates if the chat UI changes.
- The bridge only sends messages to your local machine. No cloud relay is used.
- If you update this folder, reload the extension in `chrome://extensions/` and refresh the Pump livechat tab.
