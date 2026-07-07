# Card artwork drop-in folder

Every card in HOSTILE TAKEOVER renders an **art frame**. By default the frame
shows deterministic procedural placeholder art (faction-colored inline SVG with
a faint `ART PENDING` tag). To replace a card's placeholder with real artwork,
**just drop an image file in this folder** — no code changes required.

## File naming

One file per card, named by the card id from the card database:

```
client/assets/card-art/<cardId>.png     (checked first)
client/assets/card-art/<cardId>.jpg     (fallback)
client/assets/card-art/<cardId>.webp    (fallback)
```

Examples: `vx_004.png`, `nx_ceo.jpg`, `ntr_subsidy.webp`.

## Art style (IMPORTANT — keep consistent)

**Painterly digital illustration, in the Magic: The Gathering tradition** — visible
brushwork, dramatic *painted* lighting, rich stylized color, a clear focal subject.
Think Chris Rahn / Volkan Bağa / Ryan Pancoast: it should read as a hand-painted
oil illustration, **not** a photograph or a cinematic 3D render.

- DO ask for: "painterly", "digital oil painting", "illustrated", "concept-art
  style", "visible brushstrokes", "dramatic painterly lighting".
- DON'T ask for: "photorealistic", "photograph", "cinematic photo", "octane/UE5
  render", "hyperrealistic" — these break the deck's visual cohesion.
- Tone stays on-theme: sleek corporate cyberpunk with dry satirical bite
  (Bloomberg-terminal-meets-Blade-Runner-boardroom), just rendered *as a painting*.

## Recommended dimensions

- **≥ 512 × 384 px**, roughly **4:3 landscape** (≈800–1000 px wide is plenty; the
  frame is small, so don't ship needlessly huge files).
- The image fills the frame with `object-fit: cover`, so anything close to 4:3
  works; edges may be cropped on other ratios. Keep the subject centered.

## Behavior

- The client probes `<cardId>.png` → `.jpg` → `.webp` once per card id and
  caches the result for the session (missing files are only probed once).
- If an image is found it **fully replaces** the procedural placeholder
  (no watermark) everywhere the card appears: hand, board, deck builder grid,
  deck lists, and the enlarged hover preview.
- If no image is found, the procedural placeholder stays, marked `ART PENDING`
  so it is easy to see which cards still need art.
