# Luci Playback

Player for [Luci](https://luci.memories.ai) screen-memory frames. It never uploads images.

Anyone can open the site, choose **their** Luci folder, and play frames in the browser.

## Public site

https://luci.luisliuchao.com · [About](https://luci.luisliuchao.com/about.html)

1. Open the site. There is no login.
2. Click **Choose folder**.
3. Pick your Luci home:
   - macOS: press Cmd+Shift+G and paste `~/.luciMicrosoft`
   - Linux / Windows: pick `~/.luci`
4. If frames are encrypted, enter the Luci Safe Storage password. The password never leaves this computer. This browser keeps the unlock so you can refresh.

Playback follows real timestamps (usually ~5s between frames) at 1x–30x. The scrub bar is the captured day, not frame count, and the clock shows the time of the current frame. Space plays or pauses; arrows or `j`/`l` step one frame; `,`/`.` jump 10 seconds; Shift+arrows jump one minute. If the Luci folder has audio (mic or system), it plays in sync. `m` mutes.

## Decrypting frames

The browser decrypts frames on the visitor's computer. Nothing is uploaded.

1. Choose the Luci home folder so `screen-memory/.dbkey` is included.
2. Plain JPEGs play as-is.
3. Encrypted `LUCISS01` frames are unlocked with that key via WebCrypto.
4. If `.dbkey` is sealed (`v10`), enter the Luci Safe Storage password. On a Mac, copy the command from the unlock screen and run it in Terminal. That puts the password on your clipboard. Paste it into the field. The password never leaves this computer. This browser keeps the unlock so you can refresh. The browser cannot read Keychain or `secret-tool`.

```bash
security find-generic-password -s "luci-electron Safe Storage" -w | pbcopy
```
