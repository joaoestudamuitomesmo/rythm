# Rhythm Game — Base Project

A bare-bones, shape-only rhythm game (FNF-style timing, but notes travel
**right → left** into a hit zone on the left, no characters/sprites).

## Structure

```
index.html                          Menu, game, and results screens
css/style.css                       Universal stylesheet for every screen

assets/
  audio/
    music/
      EastWard/
        EastWard.json               Chart (notes, bpm, difficulties)
        EastWard.mp3                Audio for the chart (add your own)
  sfx/                               Hit sounds / UI sfx (empty for now)
  images/                            Future sprites/UI art (empty for now)

game/
  ingame/game.js                    Core engine: spawning, input, scoring
  menu/menu.js                      Menu logic: song/difficulty selection

tools/chart_generator.py            Python script: mp3 -> chart JSON
```

Each song gets its own folder under `assets/audio/music/<SongName>/`
containing both the chart JSON and the mp3, so everything for a track
lives together.

## Running it

Serve the folder with any static server (fetch() needs http, not file://):

```
python -m http.server 8000
```

Then open `http://localhost:8000`.

## Controls

`D F J K` or arrow keys map to the 4 lanes.

## Chart JSON format

```json
{
  "song": "Song Name",
  "audio": "song.mp3",
  "bpm": 120,
  "offset": 0.0,
  "difficulties": {
    "easy":   [ { "time": 1.0, "lane": 0 }, ... ],
    "normal": [ { "time": 1.0, "lane": 0 }, ... ],
    "hard":   [ { "time": 1.0, "lane": 0 }, ... ]
  }
}
```

`time` is in seconds from the start of the audio. `lane` is 0-3.
`audio` is just the filename — it's resolved relative to the folder the
chart JSON itself lives in (e.g. `assets/audio/music/EastWard/`).

## Adding a new song

1. Create `assets/audio/music/<SongName>/` and drop your mp3 in it.
2. Generate a chart straight into that same folder:
   ```
   pip install librosa numpy soundfile
   python tools/chart_generator.py assets/audio/music/<SongName>/<SongName>.mp3 \
       -o assets/audio/music/<SongName>/<SongName>.json -n "Song Name"
   ```
3. Add an entry to `SONG_LIST` in `game/menu/menu.js`:
   ```js
   { id: "songname", name: "Song Name", chart: "assets/audio/music/<SongName>/<SongName>.json" }
   ```

## Notes on the engine

- Timing is driven by `audio.currentTime`, not `setInterval`, so it stays
  in sync with the actual playback.
- `NOTE_TRAVEL_TIME` in `game/ingame/game.js` controls how long a note
  takes to cross the track (reaction time) — tweak to taste.
- Judgement windows (`sick` / `good` / `bad` / `miss`) and their point
  values are also in `game/ingame/game.js`.
- This is intentionally a *base*: no sprites, no skins, just circles per
  lane so the timing/feel can be validated before art goes in.
