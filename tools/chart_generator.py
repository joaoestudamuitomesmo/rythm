#!/usr/bin/env python3
"""
chart_generator.py
-------------------
Generates rhythm game charts using multi-band onset detection,
beat-grid snapping, and Least Recently Used (LRU) lane distribution.
"""

import argparse
import json
import os
import sys
import numpy as np


def detect_enhanced_onsets(y, sr):
    import librosa

    # Split audio spectrum into 4 distinct frequency sub-bands
    channels = [0, 32, 64, 96, 128]
    onset_env_multi = librosa.onset.onset_strength_multi(y=y, sr=sr, channels=channels)

    all_frames = set()
    for band_idx in range(onset_env_multi.shape[0]):
        env = onset_env_multi[band_idx]
        frames = librosa.onset.onset_detect(
            onset_envelope=env,
            sr=sr,
            units="frames",
            wait=3,       # Prevents sub-frame duplicate triggers
            delta=0.03    # Sensitivity threshold
        )
        all_frames.update(frames.tolist())

    onset_env_combined = np.max(onset_env_multi, axis=0)
    valid_frames = [f for f in sorted(list(all_frames)) if f < len(onset_env_combined)]
    onset_frames = np.array(valid_frames)
    
    onset_times = librosa.frames_to_time(onset_frames, sr=sr)
    onset_strengths = onset_env_combined[onset_frames] if len(onset_frames) else np.array([])

    return onset_frames, onset_times, onset_strengths


def snap_to_beat_grid(times, bpm, division=16):
    """Snaps note timestamps to nearest 1/16th beat subdivisions."""
    if bpm <= 0 or len(times) == 0:
        return times

    grid_step = (60.0 / bpm) / (division / 4.0)
    return [round(round(t / grid_step) * grid_step, 3) for t in times]


def analyze_audio(path):
    import librosa

    y, sr = librosa.load(path, sr=None, mono=True)

    # --- BPM ---
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
    bpm = float(tempo) if np.isscalar(tempo) else float(tempo[0])

    # --- Multi-Band Onset Detection ---
    onset_frames, onset_times, onset_strengths = detect_enhanced_onsets(y, sr)
    
    # --- Beat Grid Quantization ---
    snapped_times = snap_to_beat_grid(onset_times, bpm, division=16)

    # --- Initial Lane Assignment (Spectral Centroid) ---
    S = np.abs(librosa.stft(y))
    centroids = librosa.feature.spectral_centroid(S=S)[0]

    onset_centroids = []
    for frame in onset_frames:
        frame = min(frame, len(centroids) - 1)
        onset_centroids.append(centroids[frame])

    lanes = []
    if len(onset_centroids) > 0:
        p25 = np.percentile(onset_centroids, 25)
        p50 = np.percentile(onset_centroids, 50)
        p75 = np.percentile(onset_centroids, 75)

        for c in onset_centroids:
            if c < p25:
                lanes.append(0)
            elif c < p50:
                lanes.append(1)
            elif c < p75:
                lanes.append(2)
            else:
                lanes.append(3)

    return {
        "bpm": round(bpm, 2),
        "duration": float(librosa.get_duration(y=y, sr=sr)),
        "onsets": snapped_times,
        "strengths": onset_strengths.tolist(),
        "lanes": lanes,
    }


def distribute_lanes_lru(raw_notes, min_same_lane_gap=0.12):
    """
    Least Recently Used (LRU) algorithm:
    Spreads fast note sequences fluidly across lanes so notes don't stack on the same key.
    """
    last_used = {0: -999.0, 1: -999.0, 2: -999.0, 3: -999.0}
    processed = []

    for note in raw_notes:
        t = note["time"]
        desired_lane = note["lane"]

        # If desired lane was hit too recently, pick the lane that has been empty longest
        if t - last_used[desired_lane] < min_same_lane_gap:
            best_lane = min(last_used, key=last_used.get)
            desired_lane = best_lane

        last_used[desired_lane] = t
        processed.append({"time": t, "lane": desired_lane})

    return processed


def build_difficulty(onsets, strengths, lanes, keep_ratio, min_global_gap, min_same_lane_gap):
    if len(onsets) == 0:
        return []

    # 1. Sort by strength to pick best onsets
    order = np.argsort(-np.array(strengths)) if len(strengths) else np.arange(len(onsets))
    keep_count = max(1, int(len(onsets) * keep_ratio))
    keep_indices = set(order[:keep_count].tolist())

    # 2. Filter out exact duplicate timestamps or notes too close globally
    time_to_note = {}
    for i in sorted(keep_indices):
        t = float(onsets[i])
        lane = int(lanes[i])
        
        # Merge notes at exact same timestamp
        if t in time_to_note:
            continue
        time_to_note[t] = lane

    # 3. Apply global minimum gap between any note start
    notes = []
    last_time = -999.0
    for t in sorted(time_to_note.keys()):
        if t - last_time < min_global_gap:
            continue
        notes.append({"time": round(t, 3), "lane": time_to_note[t]})
        last_time = t

    # 4. Smoothly distribute fast streams across lanes
    return distribute_lanes_lru(notes, min_same_lane_gap=min_same_lane_gap)


def generate_chart(mp3_path, song_name=None, offset=0.0):
    analysis = analyze_audio(mp3_path)
    onsets = analysis["onsets"]
    strengths = analysis["strengths"]
    lanes = analysis["lanes"]

    # min_global_gap: minimum time between ANY two notes (prevents impossible stacks)
    # min_same_lane_gap: minimum time before the SAME key can be pressed again
    difficulties = {
        "hard":   build_difficulty(onsets, strengths, lanes, keep_ratio=0.90, min_global_gap=0.07, min_same_lane_gap=0.14),
        "normal": build_difficulty(onsets, strengths, lanes, keep_ratio=0.55, min_global_gap=0.14, min_same_lane_gap=0.20),
        "easy":   build_difficulty(onsets, strengths, lanes, keep_ratio=0.28, min_global_gap=0.25, min_same_lane_gap=0.35),
    }

    chart = {
        "song": song_name or os.path.splitext(os.path.basename(mp3_path))[0],
        "audio": os.path.basename(mp3_path),
        "bpm": analysis["bpm"],
        "duration": round(analysis["duration"], 3),
        "offset": offset,
        "difficulties": difficulties,
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

    print(f"Chart written to {output_path}")
    print(f"BPM: {chart['bpm']}  |  Notes -> easy: {len(chart['difficulties']['easy'])}, "
          f"normal: {len(chart['difficulties']['normal'])}, hard: {len(chart['difficulties']['hard'])}")

if __name__ == "__main__":
    main()