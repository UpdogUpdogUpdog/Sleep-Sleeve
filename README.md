# Sleep Sleeve

Turns Magic: The Gathering card scans from Scryfall into dithered sleep screens for Xteink readers running CrossPoint. All image processing happens in the browser; the only network traffic is to `api.scryfall.com` (card data) and `cards.scryfall.io` (scans).

## Publish on GitHub Pages

1. Create a repository and upload everything in this folder, keeping the structure (`index.html`, `css/`, `js/`, `.nojekyll`) at the repository root.
2. In the repository, open **Settings → Pages**, set **Source** to *Deploy from a branch*, pick your branch and `/ (root)`, and save.
3. The site appears at `https://<user>.github.io/<repo>/` after a minute or two.

There is no build step. To run it locally, serve the folder over HTTP (for example `python3 -m http.server`) rather than opening `index.html` from disk; browsers block web workers on `file://`. (It still works from disk, just on the main thread, so large batches are slower.)

You can link straight to a loaded set or search with `?link=`, e.g. `https://<user>.github.io/<repo>/?link=https://scryfall.com/sets/blb`.

## Input

- Card: `https://scryfall.com/card/<set>/<number>/<name>` (language links like `/card/neo/1/ja/...` work too)
- Set: `https://scryfall.com/sets/<code>`
- Search: `https://scryfall.com/search?q=...` (keeps `unique`, `order`, `dir` and the `include_*` options)
- Or plain Scryfall search syntax, such as `t:dragon r:mythic`

Searches stop at 1,500 cards. Requests are spaced to Scryfall's published limits (2 per second for search, 10 per second otherwise) and back off for 30 seconds on HTTP 429.

## Output

| Reader | Size |
| --- | --- |
| X3 | 528 × 792 |
| X4, X4 Pro, X4 Classic | 480 × 800 |

The default file is a **4-bit BMP with a 4-entry palette of 0, 85, 170 and 255**. CrossPoint recognises palettes that match the panel's native grays and draws them directly instead of re-dithering, so what you see in the preview is what lands on the panel. 1-bit and 24-bit BMPs are also available; CrossPoint applies its own dithering to 24-bit files.

The ZIP contains a `.sleep` (or `sleep`) folder per reader. Copy that folder to the root of the SD card and set **Settings → Display → Sleep Screen** to **Custom**. CrossPoint picks one image at random each time the device sleeps.

## Processing

1. Scan converted to linear-light luminance (Rec. 709 weights). Transparent card corners are composited onto the chosen background.
2. Resampled in linear light with Lanczos 3, Mitchell, area average or nearest neighbour. Integer scale and 1 : 1 use exact nearest/box sampling.
3. Converted back to sRGB, then optional level stretch, midtone gamma, contrast, brightness and unsharp mask.
4. Error-diffusion (Floyd–Steinberg, Atkinson, Jarvis–Judice–Ninke, Stucki, Burkes, Sierra, Sierra Lite) or 8×8 Bayer dithering to 4 or 2 levels. Only image pixels are dithered, so letterbox bars stay perfectly clean.

"Panel calibration" changes the tone the ditherer assumes each middle gray has. It never changes the file palette.

## Using Scryfall's images

Scryfall's guidelines ask apps not to crop off the artist and copyright line, stretch, recolour or sharpen card images, and to credit the artist when using art crops. Converting to grayscale is inherent to this tool. The fill, stretch and sharpen options exist for personal sleep screens; the credit option (on by default when cropping hides the card's own credit or you use art crops) adds the artist's name and the Wizards of the Coast notice to the screen. If you host this publicly, keep that in mind.

Card images and data: Scryfall. Magic: The Gathering © Wizards of the Coast. Unofficial Fan Content, not endorsed by Scryfall or Wizards of the Coast.
