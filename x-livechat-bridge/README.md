# StreamHub X Livechat Bridge

Experimental Chrome/Edge/Brave extension for true X livestream chat.

This does not use private X API credentials. It reads the X chat popout that you are already logged in to and sends visible chat messages to your local StreamHub server:

```text
http://127.0.0.1:3000/x/livechat/push
```

## Install

1. Open `chrome://extensions/`.
2. Turn on `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder: `x-livechat-bridge`.

## Use

1. Start StreamHub with `npm start`.
2. Open StreamHub at `http://127.0.0.1:3000`.
3. Click `Connect X Livechat Bridge` in the X card.
4. Open your X chat popout, usually:

```text
https://x.com/YOUR_HANDLE/chat
```

5. Keep that X chat tab open while streaming.

Messages visible in the X chat popout will appear in StreamHub and the OBS overlay.

## Notes

- This bridge depends on X's current web page structure and may need updates if X changes the chat UI.
- The official X API path is still available in StreamHub for public posts, mentions, and hashtag feeds.
- The bridge only sends messages to your local machine. No cloud relay is used.
