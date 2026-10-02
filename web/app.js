const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const state = {
  transcript: "",
  sourceLabel: "",
  minutesMarkdown: "",
  minutesPlain: "",
  liveFinal: "",
  listening: false,
  mode: null, // "mic" | "tab"
  recognition: null,
  mediaStream: null,
  mediaRecorder: null,
  chunkQueue: Promise.resolve(),
};

const els = {
  title: $("#meeting-title"),
  date: $("#meeting-date"),
  participants: $("#participants"),
  useWhisper: $("#use-whisper"),
  modelField: $("#model-field"),
  modelSize: $("#model-size"),
  transcript: $("#transcript"),
  liveTranscript: $("#live-transcript"),
  interimLine: $("#interim-line"),
  liveIndicator: $("#live-indicator"),
  liveStateLabel: $("#live-state-label"),
  liveMicBtn: $("#live-mic-btn"),
  liveTabBtn: $("#live-tab-btn"),
  liveStopBtn: $("#live-stop-btn"),
  useLiveTranscript: $("#use-live-transcript"),
  clearLiveTranscript: $("#clear-live-transcript"),
  audioFile: $("#audio-file"),
  audioPreview: $("#audio-preview"),
  audioHint: $("#audio-hint"),
  transcribeBtn: $("#transcribe-btn"),
  loadSample: $("#load-sample"),
  trySampleHero: $("#try-sample-hero"),
  generateBtn: $("#generate-btn"),
  sourceChip: $("#source-chip"),
  status: $("#status"),
  minutesSection: $("#minutes"),
  minutesDoc: $("#minutes-doc"),
  statRow: $("#stat-row"),
  downloadMd: $("#download-md"),
  downloadTxt: $("#download-txt"),
};

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

els.date.value = todayISO();

function setStatus(message, kind = "") {
  els.status.textContent = message || "";
  els.status.className = `status${kind ? ` is-${kind}` : ""}`;
}

function setTranscript(text, sourceLabel) {
  state.transcript = text.trim();
  state.sourceLabel = sourceLabel;
  els.transcript.value = state.transcript;
  if (state.transcript) {
    els.sourceChip.hidden = false;
    els.sourceChip.textContent = sourceLabel;
  } else {
    els.sourceChip.hidden = true;
  }
}

function syncLiveTextarea() {
  els.liveTranscript.value = state.liveFinal.trim();
  els.liveTranscript.scrollTop = els.liveTranscript.scrollHeight;
}

function appendLiveFinal(text) {
  const piece = (text || "").trim();
  if (!piece) return;
  state.liveFinal = `${state.liveFinal} ${piece}`.replace(/\s+/g, " ").trim();
  syncLiveTextarea();
  setTranscript(state.liveFinal, state.sourceLabel || "Live transcription");
}

function setLiveState(label, dataState) {
  els.liveStateLabel.textContent = label;
  els.liveIndicator.dataset.state = dataState;
  els.liveStopBtn.disabled = dataState === "idle";
  els.liveMicBtn.disabled = dataState !== "idle";
  els.liveTabBtn.disabled = dataState !== "idle";
}

function participantsList() {
  return els.participants.value
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function switchMode(mode) {
  $$(".mode-tab").forEach((tab) => {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  });
  $$(".mode-pane").forEach((pane) => {
    const active = pane.dataset.pane === mode;
    pane.hidden = !active;
    pane.classList.toggle("is-active", active);
  });
}

$$(".mode-tab").forEach((tab) => {
  tab.addEventListener("click", () => switchMode(tab.dataset.mode));
});

els.useWhisper.addEventListener("change", () => {
  els.modelField.hidden = !els.useWhisper.checked;
  els.audioHint.textContent = els.useWhisper.checked
    ? "Whisper is enabled. Upload audio, then transcribe."
    : "Enable Whisper in meeting details to transcribe uploads.";
  updateTranscribeEnabled();
});

els.transcript.addEventListener("input", () => {
  setTranscript(els.transcript.value, "Pasted transcript");
});

els.audioFile.addEventListener("change", () => {
  const file = els.audioFile.files?.[0];
  if (!file) {
    els.audioPreview.hidden = true;
    updateTranscribeEnabled();
    return;
  }
  const url = URL.createObjectURL(file);
  els.audioPreview.src = url;
  els.audioPreview.hidden = false;
  updateTranscribeEnabled();
  setStatus(`Ready: ${file.name}`);
});

function updateTranscribeEnabled() {
  els.transcribeBtn.disabled = !(els.useWhisper.checked && els.audioFile.files?.length);
}

async function loadSample() {
  setStatus("Loading sample meeting…");
  try {
    const res = await fetch("/api/sample");
    if (!res.ok) throw new Error("Sample unavailable");
    const data = await res.json();
    setTranscript(data.transcript, "Sample meeting transcript");
    if (data.title) els.title.value = data.title;
    if (data.participants?.length) {
      els.participants.value = data.participants.join("\n");
    }
    switchMode("paste");
    setStatus("Sample loaded. Generate minutes when ready.", "ok");
    $("#workspace").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    setStatus(err.message || "Could not load sample", "error");
  }
}

els.loadSample.addEventListener("click", loadSample);
els.trySampleHero.addEventListener("click", loadSample);

els.transcribeBtn.addEventListener("click", async () => {
  const file = els.audioFile.files?.[0];
  if (!file) return;
  setStatus("Transcribing audio with Whisper… this can take a moment.");
  els.transcribeBtn.disabled = true;
  try {
    const form = new FormData();
    form.append("file", file);
    form.append("model_size", els.modelSize.value);
    const res = await fetch("/api/transcribe", { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(formatDetail(data.detail) || "Transcription failed");
    setTranscript(data.text, `Audio transcription (${data.language || "en"})`);
    switchMode("paste");
    setStatus("Transcription complete.", "ok");
  } catch (err) {
    setStatus(err.message || "Transcription failed", "error");
  } finally {
    updateTranscribeEnabled();
  }
});

function formatDetail(detail) {
  if (!detail) return "";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((d) => d.msg || JSON.stringify(d)).join(", ");
  return String(detail);
}

/* ---------------- Live speech-to-text ---------------- */

function stopLiveListening() {
  state.listening = false;

  if (state.recognition) {
    try {
      state.recognition.onend = null;
      state.recognition.stop();
    } catch (_) {
      /* ignore */
    }
    state.recognition = null;
  }

  if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
    try {
      state.mediaRecorder.stop();
    } catch (_) {
      /* ignore */
    }
  }
  state.mediaRecorder = null;

  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach((t) => t.stop());
    state.mediaStream = null;
  }

  els.interimLine.textContent = "";
  setLiveState("Idle", "idle");
  if (state.liveFinal.trim()) {
    setTranscript(state.liveFinal, state.sourceLabel || "Live transcription");
    setStatus("Listening stopped. Transcript is ready for minutes.", "ok");
  } else {
    setStatus("Listening stopped.");
  }
}

async function startMicListening() {
  if (!SpeechRecognition) {
    setStatus(
      "Live microphone transcription needs Chrome or Edge (Web Speech API).",
      "error"
    );
    return;
  }

  if (state.listening) stopLiveListening();
  state.listening = true;
  state.mode = "mic";
  state.sourceLabel = "Live microphone transcription";
  setLiveState("Listening · microphone", "listening");
  setStatus("Listening… speak, or play meeting audio through speakers near the mic.", "ok");

  const recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";
  state.recognition = recognition;

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const text = result[0].transcript;
      if (result.isFinal) {
        appendLiveFinal(text);
        els.interimLine.textContent = "";
      } else {
        interim += text;
      }
    }
    if (interim) els.interimLine.textContent = interim;
  };

  recognition.onerror = (event) => {
    if (event.error === "not-allowed") {
      setStatus("Microphone permission denied. Allow mic access and try again.", "error");
      stopLiveListening();
      return;
    }
    if (event.error === "no-speech") return;
    setStatus(`Speech recognition error: ${event.error}`, "error");
  };

  recognition.onend = () => {
    // Chrome stops periodically; restart while still listening
    if (state.listening && state.mode === "mic") {
      try {
        recognition.start();
      } catch (_) {
        /* ignore restart races */
      }
    }
  };

  try {
    recognition.start();
  } catch (err) {
    setStatus(err.message || "Could not start microphone listening", "error");
    stopLiveListening();
  }
}

function pickRecorderMime() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];
  if (!window.MediaRecorder) return "";
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

async function transcribeChunk(blob) {
  if (!blob || blob.size < 2500) return;
  const form = new FormData();
  const ext = blob.type.includes("ogg") ? "ogg" : "webm";
  form.append("file", blob, `live-chunk.${ext}`);
  form.append("model_size", els.modelSize.value || "tiny");

  const res = await fetch("/api/transcribe", { method: "POST", body: form });
  const data = await res.json();
  if (!res.ok) throw new Error(formatDetail(data.detail) || "Chunk transcription failed");
  if (data.text) appendLiveFinal(data.text);
}

async function startTabCapture() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    setStatus("Tab/meeting capture is not supported in this browser. Use Chrome.", "error");
    return;
  }

  if (state.listening) stopLiveListening();

  // Whisper required for tab audio chunks
  if (!els.useWhisper.checked) {
    els.useWhisper.checked = true;
    els.modelField.hidden = false;
    updateTranscribeEnabled();
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });
  } catch (err) {
    setStatus(
      err.name === "NotAllowedError"
        ? "Capture cancelled. Share a tab/window and enable audio."
        : err.message || "Could not start capture",
      "error"
    );
    return;
  }

  const audioTracks = stream.getAudioTracks();
  if (!audioTracks.length) {
    stream.getTracks().forEach((t) => t.stop());
    setStatus(
      "No audio track found. In Chrome, share a tab and tick “Share tab audio”.",
      "error"
    );
    return;
  }

  // Keep only audio for recording (video track not needed for STT)
  const audioStream = new MediaStream(audioTracks);
  stream.getVideoTracks().forEach((t) => t.stop());

  state.mediaStream = audioStream;
  state.listening = true;
  state.mode = "tab";
  state.sourceLabel = "Live meeting / video transcription";
  setLiveState("Capturing · meeting / video", "capturing");
  setStatus(
    "Capturing shared audio… text updates every few seconds via Whisper.",
    "ok"
  );

  audioTracks[0].addEventListener("ended", () => {
    setStatus("Shared tab/window audio ended.", "ok");
    stopLiveListening();
  });

  const mimeType = pickRecorderMime();
  if (!window.MediaRecorder || !mimeType) {
    setStatus("MediaRecorder is unavailable for live chunk transcription.", "error");
    stopLiveListening();
    return;
  }

  const recorder = new MediaRecorder(audioStream, { mimeType });
  state.mediaRecorder = recorder;

  recorder.ondataavailable = (event) => {
    const chunk = event.data;
    state.chunkQueue = state.chunkQueue
      .then(() => transcribeChunk(chunk))
      .catch((err) => {
        setStatus(err.message || "Live transcription chunk failed", "error");
      });
  };

  recorder.onerror = () => {
    setStatus("Live recorder error. Try again.", "error");
    stopLiveListening();
  };

  // Emit chunks every 6s for near-live text
  recorder.start(6000);
}

els.liveMicBtn.addEventListener("click", startMicListening);
els.liveTabBtn.addEventListener("click", startTabCapture);
els.liveStopBtn.addEventListener("click", stopLiveListening);

els.useLiveTranscript.addEventListener("click", () => {
  const text = state.liveFinal.trim() || els.liveTranscript.value.trim();
  if (!text) {
    setStatus("No live transcript yet.", "error");
    return;
  }
  setTranscript(text, state.sourceLabel || "Live transcription");
  switchMode("paste");
  setStatus("Live transcript applied. Generate minutes when ready.", "ok");
});

els.clearLiveTranscript.addEventListener("click", () => {
  state.liveFinal = "";
  els.interimLine.textContent = "";
  syncLiveTextarea();
  setStatus("Live transcript cleared.");
});

/* ---------------- Minutes rendering ---------------- */

function renderMarkdown(md) {
  let html = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  html = html.replace(/^### (.*)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.*)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.*)$/gm, "<h1>$1</h1>");
  html = html.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");

  html = html.replace(/(^\|.*\|\n(?:\|.*\|\n?)+)/gm, (block) => {
    const rows = block.trim().split("\n").filter(Boolean);
    if (rows.length < 2) return block;
    const parse = (row) =>
      row
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim());
    const head = parse(rows[0]);
    const body = rows.slice(2).map(parse);
    const thead = `<tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr>`;
    const tbody = body
      .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
      .join("");
    return `<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
  });

  html = html.replace(/^(?:- |\d+\. )(.*)$/gm, "<li>$1</li>");
  html = html.replace(/(?:<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);

  html = html
    .split(/\n{2,}/)
    .map((block) => {
      if (block.startsWith("<")) return block;
      return `<p>${block.replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");

  return html;
}

function renderStats(analysis) {
  const sentiment = analysis.sentiment || {};
  const items = [
    ["Topics", (analysis.topics || []).length],
    ["Action items", (analysis.action_items || []).length],
    ["Tone", sentiment.label || "N/A"],
  ];
  els.statRow.innerHTML = items
    .map(
      ([label, value]) =>
        `<div class="stat"><strong>${value}</strong><span>${label}</span></div>`
    )
    .join("");
}

els.generateBtn.addEventListener("click", async () => {
  const transcript =
    els.transcript.value.trim() ||
    state.transcript ||
    state.liveFinal.trim();
  if (transcript.length < 20) {
    setStatus("Add a longer transcript (live listen, paste, or sample) first.", "error");
    return;
  }

  setStatus("Running NLP analysis…");
  els.generateBtn.disabled = true;
  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript,
        meeting_title: els.title.value.trim() || null,
        meeting_date: els.date.value || todayISO(),
        participants: participantsList(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(formatDetail(data.detail) || "Analysis failed");

    state.minutesMarkdown = data.minutes_markdown;
    state.minutesPlain = data.minutes_plain;
    renderStats(data.analysis);
    els.minutesDoc.innerHTML = renderMarkdown(data.minutes_markdown);
    els.minutesSection.hidden = false;
    setStatus("Minutes ready.", "ok");
    els.minutesSection.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    setStatus(err.message || "Analysis failed", "error");
  } finally {
    els.generateBtn.disabled = false;
  }
});

function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

els.downloadMd.addEventListener("click", () => {
  if (!state.minutesMarkdown) return;
  download("meeting_minutes.md", state.minutesMarkdown, "text/markdown");
});

els.downloadTxt.addEventListener("click", () => {
  if (!state.minutesPlain) return;
  download("meeting_minutes.txt", state.minutesPlain, "text/plain");
});

window.addEventListener("beforeunload", () => {
  if (state.listening) stopLiveListening();
});
