"""AI notes / summarization provider abstraction."""

from __future__ import annotations

import re
from typing import Any, Protocol

from src.minutes_generator import format_minutes_markdown, format_minutes_plain
from src.nlp_pipeline import analyze_transcript


class AIProvider(Protocol):
    def analyze(self, transcript: str, **kwargs: Any) -> dict[str, Any]: ...


class DemoAIProvider:
    """Uses the existing local NLP pipeline — no external API key required."""

    def analyze(self, transcript: str, **kwargs: Any) -> dict[str, Any]:
        analysis = analyze_transcript(
            transcript,
            meeting_title=kwargs.get("meeting_title"),
            meeting_date=kwargs.get("meeting_date"),
            participants=kwargs.get("participants"),
        )
        questions = extract_questions(transcript)
        follow_up = suggest_follow_up(analysis)
        important = important_moments(transcript)
        analysis["questions"] = questions
        analysis["follow_up"] = follow_up
        analysis["important_moments"] = important
        analysis["key_points"] = analysis.get("discussion_points") or []
        return analysis


def extract_questions(transcript: str) -> list[str]:
    found = []
    for line in re.split(r"[\n.]+", transcript):
        line = line.strip()
        if "?" in line and len(line) > 8:
            found.append(line if line.endswith("?") else line + "?")
    # dedupe
    out, seen = [], set()
    for q in found:
        key = q.lower()
        if key not in seen:
            seen.add(key)
            out.append(q[:250])
    return out[:12]


def suggest_follow_up(analysis: dict[str, Any]) -> str:
    actions = analysis.get("action_items") or []
    if not actions:
        return "Review the summary with attendees and confirm next meeting date."
    parts = []
    for item in actions[:3]:
        parts.append(f"Follow up on: {item.get('task', '')} ({item.get('assignee', 'Unassigned')})")
    return " ".join(parts)


def important_moments(transcript: str) -> list[dict[str, str]]:
    moments = []
    for i, line in enumerate(transcript.splitlines()):
        low = line.lower()
        if any(k in low for k in ("decided", "agree", "action", "deadline", "will ", "approved")):
            moments.append({"timestamp": f"line-{i+1}", "text": line.strip()[:220]})
        if len(moments) >= 8:
            break
    return moments


class AIService:
    def __init__(self) -> None:
        self.provider: AIProvider = DemoAIProvider()

    def generate_summary(self, transcript: str, **kwargs: Any) -> str:
        return self.analyze_full(transcript, **kwargs).get("summary", "")

    def extract_key_points(self, transcript: str, **kwargs: Any) -> list[str]:
        return self.analyze_full(transcript, **kwargs).get("key_points") or []

    def extract_decisions(self, transcript: str, **kwargs: Any) -> list[str]:
        return self.analyze_full(transcript, **kwargs).get("decisions") or []

    def extract_action_items(self, transcript: str, **kwargs: Any) -> list[dict]:
        return self.analyze_full(transcript, **kwargs).get("action_items") or []

    def extract_questions(self, transcript: str, **kwargs: Any) -> list[str]:
        return self.analyze_full(transcript, **kwargs).get("questions") or []

    def analyze_full(self, transcript: str, **kwargs: Any) -> dict[str, Any]:
        return self.provider.analyze(transcript, **kwargs)

    def generate_minutes(self, transcript: str, **kwargs: Any) -> dict[str, str]:
        analysis = self.analyze_full(transcript, **kwargs)
        # enrich markdown with questions / follow-up
        md = format_minutes_markdown(analysis)
        if analysis.get("questions"):
            md += "\n## Questions Raised\n"
            for q in analysis["questions"]:
                md += f"- {q}\n"
        if analysis.get("follow_up"):
            md += f"\n## Follow-up\n{analysis['follow_up']}\n"
        return {
            "analysis": analysis,
            "minutes_markdown": md,
            "minutes_plain": format_minutes_plain(analysis),
        }


ai_service = AIService()
