"""
Voice-to-Text Meeting Minutes Generator
Streamlit demo app: audio/transcript → NLP → structured minutes
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import streamlit as st

from src.minutes_generator import format_minutes_markdown, format_minutes_plain
from src.nlp_pipeline import analyze_transcript

SAMPLE_TRANSCRIPT_PATH = Path(__file__).parent / "samples" / "sample_meeting.txt"


st.set_page_config(
    page_title="Meeting Minutes Generator",
    page_icon="📝",
    layout="wide",
)

st.title("Voice-to-Text Meeting Minutes Generator")
st.caption(
    "Upload a meeting recording or paste a transcript. "
    "Speech-to-text + NLP produce structured minutes automatically."
)


with st.sidebar:
    st.header("Meeting details")
    meeting_title = st.text_input("Meeting title", value="Weekly Project Sync")
    meeting_date = st.date_input("Meeting date")
    participants_raw = st.text_area(
        "Participants (one per line, optional)",
        value="Alex\nJordan\nSam\nPriya",
        height=120,
    )
    participants = [p.strip() for p in participants_raw.splitlines() if p.strip()]

    st.divider()
    st.header("Speech recognition")
    use_whisper = st.checkbox("Enable Whisper speech-to-text", value=False)
    model_size = st.selectbox(
        "Whisper model",
        options=["tiny", "base", "small"],
        index=1,
        help="tiny/base are faster; small is more accurate but slower.",
        disabled=not use_whisper,
    )
    st.caption(
        "Whisper downloads a model on first use and needs ffmpeg installed. "
        "Leave disabled to demo with a transcript only."
    )


tab_audio, tab_text, tab_sample = st.tabs(
    ["Audio upload", "Paste transcript", "Sample meeting"]
)

transcript = ""
source_label = ""

with tab_audio:
    audio_file = st.file_uploader(
        "Upload meeting audio",
        type=["wav", "mp3", "m4a", "ogg", "webm", "mp4"],
    )
    if audio_file is not None:
        st.audio(audio_file)
        if not use_whisper:
            st.warning(
                "Enable Whisper in the sidebar to transcribe audio, "
                "or paste a transcript in the next tab."
            )
        elif st.button("Transcribe audio", type="primary", key="transcribe_btn"):
            with st.spinner(f"Transcribing with Whisper ({model_size})..."):
                try:
                    from src.speech_to_text import transcribe_audio

                    suffix = Path(audio_file.name).suffix or ".wav"
                    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
                        tmp.write(audio_file.getvalue())
                        tmp_path = tmp.name

                    result = transcribe_audio(tmp_path, model_size=model_size)
                    Path(tmp_path).unlink(missing_ok=True)
                    transcript = result["text"]
                    source_label = f"Audio transcription ({result.get('language', 'en')})"
                    st.session_state["transcript"] = transcript
                    st.session_state["source_label"] = source_label
                    st.success("Transcription complete.")
                except Exception as exc:  # noqa: BLE001
                    st.error(f"Transcription failed: {exc}")

with tab_text:
    pasted = st.text_area(
        "Meeting transcript",
        height=280,
        placeholder="Paste the full meeting transcript here...",
    )
    if pasted.strip():
        transcript = pasted.strip()
        source_label = "Pasted transcript"
        st.session_state["transcript"] = transcript
        st.session_state["source_label"] = source_label

with tab_sample:
    st.write("Load a built-in sample meeting conversation to try the NLP pipeline.")
    if st.button("Load sample transcript", type="primary", key="sample_btn"):
        if SAMPLE_TRANSCRIPT_PATH.exists():
            sample_text = SAMPLE_TRANSCRIPT_PATH.read_text(encoding="utf-8")
            st.session_state["transcript"] = sample_text
            st.session_state["source_label"] = "Sample meeting transcript"
            st.success("Sample transcript loaded.")
        else:
            st.error("Sample file missing: samples/sample_meeting.txt")

# Prefer session transcript so buttons persist across reruns
transcript = st.session_state.get("transcript", transcript)
source_label = st.session_state.get("source_label", source_label)

st.divider()

if transcript:
    with st.expander("View transcript", expanded=False):
        if source_label:
            st.caption(source_label)
        st.write(transcript)

    if st.button("Generate meeting minutes", type="primary", key="generate_btn"):
        with st.spinner("Running NLP analysis..."):
            analysis = analyze_transcript(
                transcript,
                meeting_title=meeting_title or None,
                meeting_date=str(meeting_date),
                participants=participants or None,
            )
            minutes_md = format_minutes_markdown(analysis)
            minutes_plain = format_minutes_plain(analysis)
            st.session_state["analysis"] = analysis
            st.session_state["minutes_md"] = minutes_md
            st.session_state["minutes_plain"] = minutes_plain

else:
    st.info("Add a transcript (or transcribe audio) to generate minutes.")


if "minutes_md" in st.session_state:
    analysis = st.session_state["analysis"]
    minutes_md = st.session_state["minutes_md"]
    minutes_plain = st.session_state["minutes_plain"]

    st.subheader("Structured meeting minutes")
    st.markdown(minutes_md)

    col1, col2, col3 = st.columns(3)
    with col1:
        st.metric("Topics", len(analysis.get("topics") or []))
    with col2:
        st.metric("Action items", len(analysis.get("action_items") or []))
    with col3:
        sentiment = analysis.get("sentiment") or {}
        st.metric("Tone", sentiment.get("label", "N/A"))

    st.download_button(
        "Download minutes (.md)",
        data=minutes_md,
        file_name="meeting_minutes.md",
        mime="text/markdown",
    )
    st.download_button(
        "Download minutes (.txt)",
        data=minutes_plain,
        file_name="meeting_minutes.txt",
        mime="text/plain",
    )
