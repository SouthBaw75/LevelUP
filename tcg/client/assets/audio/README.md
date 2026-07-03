# Game audio — drop-in sound files

Drop audio files into **this folder** (`tcg/client/assets/audio/`) using the
exact names below and they play automatically — no code changes needed. Any file
that isn't here yet is simply silent, so you can add sounds one at a time.

Players can turn Music and Sound Effects on/off independently via the ⚙ button
in the bottom-right corner, in the lobby or in-game (each choice is remembered).

## File names

| File | When it plays | Type |
|------|---------------|------|
| `music-lobby.mp3` | Background music on the home & lobby / menu screens | Music — **loops** |
| `music-game.mp3`  | Background music once a match starts (the game board) | Music — **loops** |
| `ui-click.mp3`    | Any menu button click in the lobby (queue, private, VS bot, deck builder, etc.) | SFX — short |
| `select-nexus.mp3`    | Selecting **Nexus Dynamics** on the faction picker | SFX — short |
| `select-vulcan.mp3`   | Selecting **Vulcan Heavy Industries** | SFX — short |
| `select-helix.mp3`    | Selecting **Helix Biosystems** | SFX — short |
| `select-obsidian.mp3` | Selecting **Obsidian Capital** | SFX — short |
| `ui-select.mp3` *(optional)* | Fallback faction-select sound used for any faction that doesn't have its own `select-<faction>` file | SFX — short |
| `sfx-play.mp3`    | Any card (asset or operation) being played from hand | SFX — short |
| `sfx-attack.mp3`  | An asset attacking | SFX — short |
| `sfx-destroy.mp3` | An asset being destroyed | SFX — short |
| `sfx-ceo-damage.mp3` | A CEO (either player) taking damage | SFX — short |

### Notes on names
- Music tracks are set to **loop** automatically, so they can be seamless clips.
- The faction-select sound is looked up as `select-<faction>` first
  (`select-nexus`, `select-vulcan`, `select-helix`, `select-obsidian`). If that
  file is missing it falls back to `ui-select`. So you can either give each
  conglomerate its own sting, or just drop in a single `ui-select` for all four.

## Randomized variants (multiple takes of one sound)

Any SFX in the table above can have **multiple versions** that get picked at
random each time it plays — useful for `sfx-destroy` so units don't always
make the exact same crash/shatter sound. Add numbered files alongside
(or instead of) the plain one:

```
sfx-destroy.mp3      <- optional "take 0"
sfx-destroy-1.mp3
sfx-destroy-2.mp3
sfx-destroy-3.mp3
...
sfx-destroy-8.mp3     <- up to 8 numbered variants are checked
```

Every file that exists (the plain name plus any numbered ones, in any
combination) goes into the pool and one is chosen at random on each play. This
works for **every** name in the table, not just `sfx-destroy` — e.g. you could
add `sfx-attack-1.mp3` / `sfx-attack-2.mp3` for varied attack impacts, or
`ui-click-1.mp3` / `ui-click-2.mp3` for menu clicks.

## Accepted formats

Any of these extensions work (probed in this order): **`.mp3`, `.ogg`, `.m4a`, `.wav`**.
`.mp3` is the safest choice for broad browser support. Just match the base name
from the table — e.g. `music-lobby.ogg` works exactly the same as `music-lobby.mp3`.

## Suggested levels
- Music is played at ~40% volume and loops; keep tracks fairly even/ambient.
- SFX play at ~70% volume; keep click/select sounds short (< 1s) and not too loud.
