// ============================================================
// game.js - core rhythm engine.
// Notes travel from BOTTOM to TOP toward a fixed hit zone at the top.
// Exposes window.RhythmGame.start(songEntry, difficulty)
// ============================================================

(function () {
  const LANES = 4;
  const KEY_TO_LANE = {
    "d": 0, "f": 1, "j": 2, "k": 3,
    "lmb": 2, "s": 1, "w": 0, "rmb": 3
  };

  // How long (seconds) a note takes to travel from spawn (bottom edge)
  // to the hit zone (top edge). Bigger = more reaction time.
  const NOTE_TRAVEL_TIME = 1.4;

  // Judgement windows in seconds (absolute time difference)
  const WINDOWS = {
    sick: 0.05,
    good: 0.10,
    bad:  0.16
  };
  const MISS_WINDOW = 0.20; // beyond this, note is auto-missed

  const SCORE = { sick: 100, good: 70, bad: 30, miss: 0 };

  const DIFFICULTY_KEYS = ["easy", "normal", "hard"];

  let audioEl, trackContainer, receptors, scoreDisplay, comboDisplay,
      accuracyDisplay, progressFill;

  let chartData = null;
  let activeNotes = [];   // notes currently spawned & on screen {el, time, lane, hit}
  let allNotes = [];      // full note list for current difficulty, sorted by time
  let nextNoteIndex = 0;
  let score = 0, combo = 0, maxCombo = 0;
  let hitCount = 0, totalJudged = 0, accuracySum = 0;
  let rafId = null;
  let trackHeight = 0;
  let finished = false;

  function $(id) { return document.getElementById(id); }

  function cacheDom() {
    audioEl = $("song-audio");
    trackContainer = $("track-container");
    receptors = Array.from(document.querySelectorAll(".receptor"));
    scoreDisplay = $("score-display");
    comboDisplay = $("combo-display");
    accuracyDisplay = $("accuracy-display");
    progressFill = $("progress-bar-fill");
  }

  async function loadChart(chartPath) {
    const res = await fetch(chartPath);
    if (!res.ok) throw new Error("Failed to load chart: " + chartPath);
    return res.json();
  }

  function resetState() {
    activeNotes.forEach(n => n.el && n.el.remove());
    activeNotes = [];
    nextNoteIndex = 0;
    score = 0; combo = 0; maxCombo = 0;
    hitCount = 0; totalJudged = 0; accuracySum = 0;
    finished = false;
    updateHud();
    progressFill.style.width = "0%";
  }

  function updateHud() {
    scoreDisplay.textContent = "SCORE: " + score;
    comboDisplay.textContent = combo > 1 ? combo + "x COMBO" : "";
    const acc = totalJudged > 0 ? (accuracySum / totalJudged) * 100 : 100;
    accuracyDisplay.textContent = "ACC: " + acc.toFixed(1) + "%";
  }

  function spawnNote(noteData) {
    const el = document.createElement("div");
    el.className = "note lane-" + noteData.lane;
    trackContainer.querySelector(`.lane[data-lane="${noteData.lane}"]`).appendChild(el);
    const noteObj = { el, time: noteData.time, lane: noteData.lane, judged: false };
    activeNotes.push(noteObj);
    return noteObj;
  }

  function receptorY() {
    // Top offset of receptor center, matches CSS top: 20px + half height
    const size = getComputedStyle(document.documentElement).getPropertyValue("--receptor-size");
    const px = parseFloat(size) || 70;
    return 20 + px / 2;
  }

  function noteSizePx() {
    const size = getComputedStyle(document.documentElement).getPropertyValue("--receptor-size");
    return parseFloat(size) || 70;
  }

  function gameLoop() {
    if (!audioEl || (audioEl.paused && !finished && audioEl.currentTime === 0)) {
      // not started yet
    }
    const currentTime = audioEl.currentTime;
    trackHeight = trackContainer.clientHeight;

    // Spawn upcoming notes
    while (nextNoteIndex < allNotes.length &&
           allNotes[nextNoteIndex].time - NOTE_TRAVEL_TIME <= currentTime) {
      spawnNote(allNotes[nextNoteIndex]);
      nextNoteIndex++;
    }

    const rY = receptorY();
    const noteSize = noteSizePx();
    const bottomEdgeY = trackHeight - noteSize / 2;

    // Update positions & check for misses (move UP from bottom to top)
    for (let i = activeNotes.length - 1; i >= 0; i--) {
      const n = activeNotes[i];
      const spawnTime = n.time - NOTE_TRAVEL_TIME;
      const progress = (currentTime - spawnTime) / NOTE_TRAVEL_TIME;
      
      // Calculate Y coordinate (moving from bottomEdgeY UP towards rY)
      const y = bottomEdgeY + (rY - bottomEdgeY) * progress - noteSize / 2;
      n.el.style.top = y + "px";

      const delta = currentTime - n.time;
      if (!n.judged && delta > MISS_WINDOW) {
        judgeNote(n, "miss");
      }

      if (n.judged && (progress > 1.15 || delta > MISS_WINDOW + 0.05)) {
        n.el.remove();
        activeNotes.splice(i, 1);
      }
    }

    // Progress bar
    if (audioEl.duration) {
      progressFill.style.width = (currentTime / audioEl.duration) * 100 + "%";
    }

    // End of song check
    if (!finished && audioEl.duration &&
        currentTime >= audioEl.duration - 0.05 &&
        nextNoteIndex >= allNotes.length &&
        activeNotes.every(n => n.judged)) {
      finished = true;
      endSong();
      return;
    }

    rafId = requestAnimationFrame(gameLoop);
  }

  function judgeNote(noteObj, forcedJudgement) {
    if (noteObj.judged) return;
    noteObj.judged = true;

    let judgement = forcedJudgement;
    if (!judgement) {
      const delta = Math.abs(audioEl.currentTime - noteObj.time);
      if (delta <= WINDOWS.sick) judgement = "sick";
      else if (delta <= WINDOWS.good) judgement = "good";
      else if (delta <= WINDOWS.bad) judgement = "bad";
      else judgement = "miss";
    }

    score += SCORE[judgement];
    totalJudged++;
    if (judgement === "miss") {
      combo = 0;
      accuracySum += 0;
    } else {
      combo++;
      maxCombo = Math.max(maxCombo, combo);
      hitCount++;
      const accWeight = judgement === "sick" ? 1 : judgement === "good" ? 0.7 : 0.4;
      accuracySum += accWeight;
    }

    showJudgement(judgement, noteObj.lane);
    flashReceptor(noteObj.lane, judgement !== "miss");
    updateHud();

    if (judgement === "miss") {
      noteObj.el.style.opacity = "0.15";
    } else {
      noteObj.el.style.opacity = "0";
    }
  }

  function showJudgement(judgement, lane) {
    const label = { sick: "SICK!", good: "GOOD", bad: "BAD", miss: "MISS" }[judgement];
    const el = document.createElement("div");
    el.className = "judgement " + judgement;
    el.textContent = label;
    trackContainer.appendChild(el);
    setTimeout(() => el.remove(), 400);
  }

  function flashReceptor(lane, hit) {
    const receptor = receptors[lane];
    receptor.classList.add("active");
    receptor.style.borderColor = hit ? getLaneColor(lane) : "#ff3c3c";
    setTimeout(() => {
      receptor.classList.remove("active");
      receptor.style.borderColor = "";
    }, 100);
  }

  function getLaneColor(lane) {
    return getComputedStyle(document.documentElement).getPropertyValue("--lane" + lane);
  }

  function findClosestUnjudgedNote(lane) {
    let best = null, bestDelta = Infinity;
    for (const n of activeNotes) {
      if (n.judged || n.lane !== lane) continue;
      const delta = Math.abs(audioEl.currentTime - n.time);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = n;
      }
    }
    if (best && bestDelta <= MISS_WINDOW) return best;
    return null;
  }

  // --- INPUT HANDLERS ---
  function handleKeyDown(e) {
    const key = e.key.toLowerCase();
    if (!(key in KEY_TO_LANE)) return;
    triggerInput(KEY_TO_LANE[key]);
  }

  function handleMouseDown(e) {
    let key = null;
    if (e.button === 0) key = "lmb";       // Left Click
    else if (e.button === 2) key = "rmb";  // Right Click

    if (!key || !(key in KEY_TO_LANE)) return;
    triggerInput(KEY_TO_LANE[key]);
  }

  function preventContextMenu(e) {
    e.preventDefault(); // Prevents right-click menu during gameplay
  }

  function triggerInput(lane) {
    flashReceptor(lane, true);
    const note = findClosestUnjudgedNote(lane);
    if (note) judgeNote(note);
  }

  function endSong() {
    cancelAnimationFrame(rafId);
    
    // Clean up input listeners
    document.removeEventListener("keydown", handleKeyDown);
    document.removeEventListener("mousedown", handleMouseDown);
    document.removeEventListener("contextmenu", preventContextMenu);

    const acc = totalJudged > 0 ? (accuracySum / totalJudged) * 100 : 100;
    $("result-score").textContent = score;
    $("result-combo").textContent = maxCombo;
    $("result-accuracy").textContent = acc.toFixed(1) + "%";

    let rank = "D";
    if (acc >= 95) rank = "S";
    else if (acc >= 85) rank = "A";
    else if (acc >= 70) rank = "B";
    else if (acc >= 50) rank = "C";
    $("result-rank").textContent = "RANK: " + rank;

    document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
    $("results-screen").classList.add("active");
  }

  async function start(songEntry, difficulty) {
    cacheDom();
    resetState();

    chartData = await loadChart(songEntry.chart);

    let diffKey = DIFFICULTY_KEYS.includes(difficulty) ? difficulty : "normal";
    let notes = chartData.difficulties[diffKey];
    if (!notes) {
      diffKey = DIFFICULTY_KEYS.find(k => chartData.difficulties[k]);
      notes = chartData.difficulties[diffKey];
    }
    allNotes = notes.slice().sort((a, b) => a.time - b.time);

    let audioPath = chartData.audio;
    if (!audioPath.startsWith("http") && !audioPath.startsWith("/")) {
      const chartDir = songEntry.chart.substring(0, songEntry.chart.lastIndexOf("/") + 1);
      audioPath = chartDir + chartData.audio;
    }
    audioEl.src = audioPath;
    audioEl.currentTime = 0;

    await new Promise(resolve => {
      audioEl.oncanplaythrough = resolve;
      audioEl.load();
    });

    // Attach keyboard and mouse input listeners
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("contextmenu", preventContextMenu);

    audioEl.play();
    rafId = requestAnimationFrame(gameLoop);
  }

  window.RhythmGame = { start };
})();