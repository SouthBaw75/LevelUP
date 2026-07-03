# Faction symbols — drop-in artwork

Drop a circular emblem image here to replace the placeholder monogram shown on
every card's faction badge (the small circle pinned to the bottom-left corner
of the card art). Every card of that conglomerate — asset, operation, power —
picks it up automatically.

## Naming

One icon per faction. Name the file after the faction id:

| File               | Conglomerate            |
|--------------------|--------------------------|
| `nexus.png`        | Nexus Dynamics (AI)      |
| `vulcan.png`       | Vulcan Heavy Industries  |
| `helix.png`        | Helix Biosystems         |
| `obsidian.png`     | Obsidian Capital         |
| `neutral.png`      | Independent Contractors |

`.webp` also works (probed after `.png`). **`.jpg` is intentionally not
supported here** — unlike card art and CEO portraits, this image needs a
transparent background to read as a badge, and JPEG can't hold alpha.

If no file exists for a faction, the badge shows a placeholder monogram
(N / V / H / O / IC) in that faction's accent color — so you can add icons
one at a time and see at a glance which ones are still pending.

## Recommended format

- **Circular, transparent background, roughly 512×512.** The badge crops to a
  perfect circle regardless, so a square canvas with the emblem centered and
  the rest transparent is exactly right.
- Keep the design simple and bold — it renders as small as ~20px on a card in
  a hand fan, so fine detail will be lost. High contrast against the accent
  color reads best.
- No code changes are needed — just drop the file in and reload.
