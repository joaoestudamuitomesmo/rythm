#!/usr/bin/env python3
"""
chart_generator.py
-------------------
Analyzes an .mp3 and produces a chart JSON compatible with game/ingame/game.js.

Design goals (this is the part that makes it feel good to play, not just
technically "in sync"):

  1. Adaptive onset selection instead of a flat "top X% loudest onsets".
     A raw loudness threshold biases picks toward the chorus/drop and
     starves quiet verses of notes. Onset strength is normalized against
     a local (~3s) rolling baseline first, so quiet and loud sections get
     a comparable density of notes relative to *their own* dynamics.

  2. Nested difficulties. Normal is built by thinning Hard, Easy is built
     by thinning Normal — not three independent selections from raw
     onsets. This keeps the same chart "skeleton" across difficulties so
     a song feels like the same song at every level, just denser/sparser,
     which is what actually reads as "fair" to a player switching
     difficulties.

  3. Hard per-difficulty caps: a minimum gap between notes (global and
     per-lane) AND a rolling notes-per-second ceiling. Onset detectors
     love to spam during cymbal rolls / noisy transients; without a cap
     that turns into an unreadable, unplayable blob rather than a
     "hard" pattern.

  4. Grid snapping is tolerance-based, not forced. Onsets close to a
     beat subdivision snap to it (tight, danceable timing); onsets that
     are clearly syncopated/off-grid are left where they are instead of
     being dragged onto the wrong beat.

  5. BPM sanity clamp: librosa's tempo estimate occasionally reports
     half/double the "felt" tempo. We nudge it back into a normal
     dance-tempo range since the BPM value itself isn't used for
     anything except the beat grid.

Usage:
    python chart_generator.py song.mp3 -o assets/audio/music/Song/Song.json -n "Song Name"

Requirements:
    pip install librosa numpy soundfile
    (scipy is a librosa dependency and is used here too, if present)
"""

import argparse
import json
import os
import sys

import numpy as np

try:
    from scipy.ndimage import median_filter
    HAVE_SCIPY = True
except ImportError:
    HAVE_SCIPY = False


# ----------------------------------------------------------------------
# Onset detection
# ----------------------------------------------------------------------

def detect_multiband_onsets(y, sr):
    """Runs onset detection on 4 frequency sub-bands separately and
    merges them. This catches both low-end (kick/bass) and high-end
    (hats/snare) hits that a single full-spectrum onset detector often
    smooths over or misses."""
    import librosa

    channels = [0, 32, 64, 96, 128]
    onset_env_multi = librosa.onset.onset_strength_multi(y=y, sr=sr, channels=channels)
    onset_env_combined = np.max(onset_env_multi, axis=0)

    all_frames = set()
    for band_idx in range(onset_env_multi.shape[0]):
        frames = librosa.onset.onset_detect(
            onset_envelope=onset_env_multi[band_idx],
            sr=sr,
            units="frames",
            wait=3,
            delta=0.03,
        )
        all_frames.update(frames.tolist())

    onset_frames = np.array(sorted(f for f in all_frames if f < len(onset_env_combined)))
    return onset_frames, onset_env_combined


def normalize_strength(onset_env_combined, onset_frames, sr, hop_length=512, window_seconds=3.0):
    """Scores each onset relative to a local rolling baseline instead of
    the song's global loudness, so quiet sections aren't starved of
    notes and loud sections don't get flooded."""
    if len(onset_frames) == 0:
        return np.array([])

    if HAVE_SCIPY:
        frames_per_window = max(3, int((window_seconds * sr / hop_length) // 2 * 2 + 1))  # odd
        baseline = median_filter(onset_env_combined, size=frames_per_window)
    else:
        baseline = np.full_like(onset_env_combined, np.median(onset_env_combined))

    normalized_env = onset_env_combined / (baseline + 1e-6)
    return normalized_env[onset_frames]


def sanitize_bpm(bpm):
    """Nudges half/double-time tempo detections back into a normal
    dance-tempo range (used only for the beat grid, not scoring)."""
    while bpm < 80 and bpm > 0:
        bpm *= 2
    while bpm > 175:
        bpm /= 2
    return bpm


def snap_to_beat_grid(times, bpm, division=8, tolerance_ratio=0.35):
    """Snaps a note to the nearest 1/division beat ONLY if it's already
    close (within tolerance_ratio of a grid step). Onsets that are
    clearly syncopated are left alone instead of being forced onto the
    wrong beat."""
    if bpm <= 0 or len(times) == 0:
        return list(times)

    grid_step = (60.0 / bpm) / (division / 4.0)
    tolerance = grid_step * tolerance_ratio

    snapped = []
    for t in times:
        nearest = round(t / grid_step) * grid_step
        snapped.append(round(nearest, 3) if abs(nearest - t) <= tolerance else round(t, 3))
    return snapped


# ----------------------------------------------------------------------
# Lane assignment
# ----------------------------------------------------------------------

def assign_lanes_by_pitch(y, onset_frames):
    """Buckets each onset into one of 4 lanes by where its spectral
    centroid falls relative to the song's own distribution (low-pitched
    hits vs high-pitched hits land on different lanes)."""
    import librosa

    S = np.abs(librosa.stft(y))
    centroids = librosa.feature.spectral_centroid(S=S)[0]

    onset_centroids = [centroids[min(f, len(centroids) - 1)] for f in onset_frames]
    if not onset_centroids:
        return []

    p25, p50, p75 = np.percentile(onset_centroids, [25, 50, 75])
    lanes = []
    for c in onset_centroids:
        if c < p25:
            lanes.append(0)
        elif c < p50:
            lanes.append(1)
        elif c < p75:
            lanes.append(2)
        else:
            lanes.append(3)
    return lanes


def distribute_lanes(notes, min_same_lane_gap):
    """Prevents the same lane from firing twice in a row too fast (feels
    like a stutter) and breaks up long same-lane runs by rotating to
    whichever lane has been idle longest."""
    last_used = {0: -999.0, 1: -999.0, 2: -999.0, 3: -999.0}
    run_length = {0: 0, 1: 0, 2: 0, 3: 0}
    out = []

    for note in notes:
        t, lane = note["time"], note["lane"]

        too_soon = t - last_used[lane] < min_same_lane_gap
        too_long_run = run_length[lane] >= 3  # avoid unreadable same-key spam

        if too_soon or too_long_run:
            lane = min(last_used, key=last_used.get)

        for l in run_length:
            run_length[l] = run_length[l] + 1 if l == lane else 0

        last_used[lane] = t
        out.append({**note, "time": t, "lane": lane})

    return out


# ----------------------------------------------------------------------
# Difficulty construction
# ----------------------------------------------------------------------

def enforce_gap(notes, min_global_gap):
    """Drops notes that land too close to the previous one (global,
    across all lanes) — prevents impossible/unreadable stacks."""
    out = []
    last_time = -999.0
    for n in sorted(notes, key=lambda n: n["time"]):
        if n["time"] - last_time < min_global_gap:
            continue
        out.append(n)
        last_time = n["time"]
    return out


def enforce_nps_cap(notes, max_nps):
    """Caps notes to a rolling 1-second window so busy transient sections
    (cymbal rolls, noisy breakdowns) can't spam more than is humanly
    readable, even after everything else."""
    if not max_nps or not notes:
        return notes
    kept = []
    window = []
    for n in sorted(notes, key=lambda n: n["time"]):
        window = [t for t in window if n["time"] - t < 1.0]
        if len(window) >= max_nps:
            continue
        window.append(n["time"])
        kept.append(n)
    return kept


def build_hard(onsets, scores, lanes, min_global_gap, min_same_lane_gap, max_nps, keep_ratio):
    """Base skeleton: the fullest, most-detailed reading of the track."""
    if not onsets:
        return []

    order = np.argsort(-np.array(scores))
    keep_count = max(1, int(len(onsets) * keep_ratio))
    keep_indices = sorted(order[:keep_count].tolist())

    raw = [{"time": round(float(onsets[i]), 3), "lane": int(lanes[i]), "score": float(scores[i])}
           for i in keep_indices]

    # de-dupe exact-timestamp collisions from multi-band merging
    seen_times = {}
    for n in raw:
        seen_times.setdefault(n["time"], n)
    raw = list(seen_times.values())

    raw = enforce_gap(raw, min_global_gap)
    raw = enforce_nps_cap(raw, max_nps)
    raw = distribute_lanes(raw, min_same_lane_gap)
    return raw


def thin_from(parent_notes, parent_scores_by_time, ratio, min_global_gap, min_same_lane_gap, max_nps):
    """Builds a sparser difficulty by keeping the strongest fraction of
    an existing (denser) difficulty's notes, so easier difficulties are
    a genuine subset of harder ones rather than a separate selection."""
    if not parent_notes:
        return []

    scored = sorted(parent_notes, key=lambda n: -parent_scores_by_time.get(n["time"], 0))
    keep_count = max(1, int(len(scored) * ratio))
    kept = sorted(scored[:keep_count], key=lambda n: n["time"])

    kept = enforce_gap(kept, min_global_gap)
    kept = enforce_nps_cap(kept, max_nps)
    kept = distribute_lanes(kept, min_same_lane_gap)
    return kept


# ----------------------------------------------------------------------
# Top-level analysis + chart assembly
# ----------------------------------------------------------------------

def analyze_audio(path):
    import librosa

    y, sr = librosa.load(path, sr=None, mono=True)

    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    bpm = sanitize_bpm(float(tempo) if np.isscalar(tempo) else float(tempo[0]))

    onset_frames, onset_env_combined = detect_multiband_onsets(y, sr)
    onset_times = librosa.frames_to_time(onset_frames, sr=sr)
    scores = normalize_strength(onset_env_combined, onset_frames, sr)

    snapped_times = snap_to_beat_grid(onset_times, bpm, division=8)
    lanes = assign_lanes_by_pitch(y, onset_frames)

    return {
        "bpm": round(bpm, 2),
        "duration": float(librosa.get_duration(y=y, sr=sr)),
        "onsets": snapped_times,
        "scores": scores.tolist() if len(scores) else [],
        "lanes": lanes,
    }


def generate_chart(mp3_path, song_name=None, offset=0.0):
    analysis = analyze_audio(mp3_path)
    onsets, scores, lanes = analysis["onsets"], analysis["scores"], analysis["lanes"]

    # Hard: the full, detailed skeleton every other difficulty thins out of.
    hard = build_hard(
        onsets, scores, lanes,
        min_global_gap=0.09, min_same_lane_gap=0.14, max_nps=8, keep_ratio=0.85,
    )
    scores_by_time = {n["time"]: n["score"] for n in hard}

    normal = thin_from(hard, scores_by_time, ratio=0.62,
                        min_global_gap=0.16, min_same_lane_gap=0.20, max_nps=5)
    easy = thin_from(normal, scores_by_time, ratio=0.55,
                      min_global_gap=0.30, min_same_lane_gap=0.35, max_nps=3)

    strip_score = lambda notes: [{"time": n["time"], "lane": n["lane"]} for n in notes]

    chart = {
        "song": song_name or os.path.splitext(os.path.basename(mp3_path))[0],
        "audio": os.path.basename(mp3_path),
        "bpm": analysis["bpm"],
        "duration": round(analysis["duration"], 3),
        "offset": offset,
        "difficulties": {
            "hard": strip_score(hard),
            "normal": strip_score(normal),
            "easy": strip_score(easy),
        },
    }
    return chart


def main():
    parser = argparse.ArgumentParser(description="Generate a rhythm-game chart JSON from an mp3.")
    parser.add_argument("mp3", help="Path to the input .mp3 file")
    parser.add_argument("-o", "--output", help="Output chart JSON path", default=None)
    parser.add_argument("-n", "--name", help="Song display name", default=None)
    parser.add_argument("--offset", type=float, default=0.0,
                         help="Global timing offset in seconds (positive = delay notes)")
    args = parser.parse_args()

    if not os.path.isfile(args.mp3):
        print(f"Error: file not found: {args.mp3}", file=sys.stderr)
        sys.exit(1)

    try:
        chart = generate_chart(args.mp3, song_name=args.name, offset=args.offset)
    except ImportError:
        print("Missing dependency. Install with: pip install librosa numpy soundfile",
              file=sys.stderr)
        sys.exit(1)

    output_path = args.output or (os.path.splitext(os.path.basename(args.mp3))[0] + ".json")
    out_dir = os.path.dirname(output_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    with open(output_path, "w") as f:
        json.dump(chart, f, indent=2)

    d = chart["difficulties"]
    print(f"Chart written to {output_path}")
    print(f"BPM: {chart['bpm']}  |  Notes -> easy: {len(d['easy'])}, "
          f"normal: {len(d['normal'])}, hard: {len(d['hard'])}")


if __name__ == "__main__":
    main()
