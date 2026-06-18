# StreamHub YouTube Livechat Bridge

Experimental Chrome/Edge/Brave extension for YouTube live chat without using YouTube API quota.

This reads visible messages from an open YouTube live chat page or popout and sends them to your local StreamHub server:

```text
http://127.0.0.1:3000/youtube/livechat/push
```

## Install

1. Open `chrome://extensions/`.
2. Turn on `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder: `youtube-livechat-bridge`.

## Use

1. Start StreamHub with `npm start`.
2. Open StreamHub at `http://127.0.0.1:3000`.
3. Paste the YouTube live URL in the YouTube card.
4. Click `Connect YouTube Bridge`.
5. Open the YouTube live chat or popout chat and keep it open while streaming.

Best option:

```text
https://www.youtube.com/live_chat?is_popout=1&v=VIDEO_ID
```

## Notes

- This bridge avoids YouTube Data API quota because it reads the chat page you already have open.
- It depends on YouTube's current web page structure and may need updates if YouTube changes the chat UI.
- The bridge only sends messages to your local machine. No cloud relay is used.
- If you update this folder, reload the extension in `chrome://extensions/` and refresh the YouTube chat tab.
