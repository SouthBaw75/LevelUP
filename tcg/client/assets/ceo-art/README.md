# CEO portraits — drop-in artwork

Drop an image here to replace the procedural placeholder portrait for a
conglomerate's CEO. It's used on the **lobby faction-select cards** and on the
**in-game hero plates** (both players' CEO portraits).

## Naming

One portrait per faction. Name the file after the faction id:

| File                | Conglomerate            |
|---------------------|-------------------------|
| `nexus.png`         | Nexus Dynamics (AI)     |
| `vulcan.png`        | Vulcan Heavy Industries |
| `helix.png`         | Helix Biosystems        |
| `obsidian.png`      | Obsidian Capital        |

`.png`, `.jpg`, and `.webp` are all accepted (probed in that order). If no file
exists, the game falls back to the generated placeholder portrait automatically —
so you can add them one at a time.

## Recommended dimensions

- **Portrait / square**, at least **512×512** (the lobby card crops to a tall
  slice on the right; the hero plate crops to a 58×58 square).
- Images are shown with `object-fit: cover; object-position: top center`, so
  keep the face in the **upper-center** of the frame.
- No code changes are needed — just drop the file in and reload.
