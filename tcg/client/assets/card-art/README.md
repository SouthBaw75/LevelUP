# Card artwork drop-in folder

Every card in HOSTILE TAKEOVER renders an **art frame**. By default the frame
shows deterministic procedural placeholder art (faction-colored inline SVG with
a faint `ART PENDING` tag). To replace a card's placeholder with real artwork,
**just drop an image file in this folder** — no code changes required.

## File naming

One file per card, named by the card id from the card database:

```
client/assets/card-art/<cardId>.webp    (checked first — the shipped format)
client/assets/card-art/<cardId>.png     (fallback for a not-yet-optimized master)
client/assets/card-art/<cardId>.jpg     (fallback)
```

Examples: `vx_004.webp`, `nx_ceo.webp`, `ntr_subsidy.webp`.

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

- **≥ 512 × 384 px**, roughly **4:3 landscape**. Keep the subject centered —
  the image fills the frame with `object-fit: cover`, so anything close to 4:3
  works; edges may be cropped on other ratios.

## Optimize before shipping (IMPORTANT)

Cards never render larger than the ~250 px hover preview, so a full-res PNG
master (2–3 MB) makes online players download 20–30× more than they see —
that's the multi-second "art pops in late" lag. **Ship WebP, not PNG.**

Drop your PNG/JPG masters in here, then from `client/assets/` run:

```
python3 optimize-art.py
```

It resizes to a web-sane resolution, writes `<id>.webp` (≈100 KB, visually
identical at display size), and removes the source PNG/JPG. It's re-runnable:
already-WebP files are skipped, so you can drop one new master and re-run to
convert just the newcomer. Keep your PNG masters on your own machine. The
script covers `card-art/`, `ceo-art/`, `faction-icons/` (alpha preserved), and
`splash-screen/`.

## Behavior

- The client probes `<cardId>.webp` → `.png` → `.jpg` once per card id and
  caches the result for the session (missing files are only probed once). A
  raw PNG dropped in still shows — it's just heavier until you run the
  optimizer.
- If an image is found it **fully replaces** the procedural placeholder
  (no watermark) everywhere the card appears: hand, board, deck builder grid,
  deck lists, and the enlarged hover preview.
- If no image is found, the procedural placeholder stays, marked `ART PENDING`
  so it is easy to see which cards still need art.
