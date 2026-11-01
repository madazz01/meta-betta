# 08i — Paste pictures and files

Read `AGENTS.md` first. Start on a clean tree. This one breaks the freeze on purpose: a chat
you can't paste into feels broken (Bryan). Do this before brief 10.

## Why
People paste screenshots all day ("look at this error"), and drop files in to ask about them.
Today the input box only takes text.

## What the SDK gives us
- **Images:** `session.sendUserTurn({ input: [...] })` takes parts. Besides `{type:"text"}`
  there's `{ type: "image", mediaType: "image/png", base64Data, width, height }`
  (`TurnInputPart` in `@muse-code/sdk/dist/src/msp.d.ts`). `width` and `height` go together or
  not at all. The bytes aren't echoed back: the transcript only carries metadata
  (`attachments` on the user message).
- **Files:** there's no file part. File mentions are text: write `@relative/path` in the text
  and Muse reads it with its own tools.

## Build
0. **Prove it first.** Write `spike/image.mjs` that sends a tiny PNG with "What colour is this
   square? One word." through serve, on the model Meta Betta uses. If the model rejects
   images, stop and report, and we'll do files only.
1. **Pictures in.** Pasting an image into the input box (a Win+Shift+S screenshot, or a copied
   image) adds it as a small thumbnail chip above the text, with a ✕ to remove it.
   - Allow up to 4 per message. Shrink anything over 1600px on the long side (canvas in the
     webview), and send PNG, or JPEG for big photos. Pass `width` and `height`.
   - The message goes out as the text part plus the image parts, in `museHost.send` (give it
     an optional `images` argument; the text-only calls stay as they are).
   - An image with no text is fine: send "(see image)" as the text.
2. **Files in.** Dropping a file on the panel (VS Code needs **Shift** held while dropping into
   a webview, so the placeholder hint says "Shift+drop files"), or pasting copied files:
   - **Inside the workspace:** insert `@relative/path` at the cursor. No copy.
   - **Outside the workspace:** copy it into `<workspace>/.meta-betta/pasted/` (create the
     folder, add `.meta-betta/` to `.gitignore` if it's a git repo and the line isn't there),
     then insert `@.meta-betta/pasted/<name>`. On a name clash, add `-2`, `-3`.
   - Image files dropped this way become image chips (like a paste), not mentions.
   - Skip anything over 20 MB with a quiet notice: "That file's too big to paste (20 MB max)."
3. **Show it in the chat.** The user's row shows the thumbnails it sent (from the webview's
   copy, kept for this session). On reload or fork replay, where bytes aren't available, show
   a muted "🖼 image" per attachment instead.
4. **Queue and steer.** A queued message keeps its images. If steer can't carry images, send
   the images with the next turn instead of steering, and say nothing.
5. **Errors in plain words.** If Muse rejects the image, show "Muse couldn't take that
   picture: <reason>" and keep the text in the box.
6. **Tests:** pure helpers for the outside-copy name (clash → `-2`), the gitignore line
   (added once, never twice), the "inside workspace → mention" rule (reuse `insideDir`), the
   resize maths, and the parts built for send (text plus images, width with height).

## Done when
- The spike shows the model reads images.
- A pasted screenshot goes in, and Muse describes it.
- Shift-dropping a file from outside lands in `.meta-betta/pasted/`, gets mentioned, and Muse
  reads it. Dropping a workspace file only mentions it.
- Build and all tests pass.

## Handover
Plain English, plus the commit `08i: paste pictures and files`. Commit only your own files.
Don't push.
