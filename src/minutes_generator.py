"""Format NLP analysis results into structured meeting minutes."""

from __future__ import annotations

from typing import Any


def format_minutes_markdown(analysis: dict[str, Any]) -> str:
    """Render structured meeting minutes as Markdown."""
    lines: list[str] = []

    lines.append(f"# {analysis.get('title', 'Meeting Minutes')}")
    lines.append("")
    lines.append(f"**Date:** {analysis.get('date', 'N/A')}")
    lines.append("")

    participants = analysis.get("participants") or []
    lines.append("## Participants")
    if participants:
        for person in participants:
            lines.append(f"- {person}")
    else:
        lines.append("- Not identified")
    lines.append("")

    topics = analysis.get("topics") or []
    lines.append("## Main Topics")
    if topics:
        for topic in topics:
            lines.append(f"- {topic}")
    else:
        lines.append("- Not identified")
    lines.append("")

    lines.append("## Summary")
    lines.append(analysis.get("summary") or "No summary available.")
    lines.append("")

    points = analysis.get("discussion_points") or []
    lines.append("## Main Discussion Points")
    if points:
        for i, point in enumerate(points, 1):
            lines.append(f"{i}. {point}")
    else:
        lines.append("1. No major discussion points extracted.")
    lines.append("")

    decisions = analysis.get("decisions") or []
    lines.append("## Important Decisions")
    if decisions:
        for decision in decisions:
            lines.append(f"- {decision}")
    else:
        lines.append("- No explicit decisions detected.")
    lines.append("")

    actions = analysis.get("action_items") or []
    lines.append("## Action Items")
    if actions:
        lines.append("| Task | Assigned To | Deadline |")
        lines.append("| --- | --- | --- |")
        for item in actions:
            task = item.get("task", "").replace("|", "/")
            assignee = item.get("assignee", "Unassigned").replace("|", "/")
            deadline = item.get("deadline", "Not specified").replace("|", "/")
            lines.append(f"| {task} | {assignee} | {deadline} |")
    else:
        lines.append("- No action items detected.")
    lines.append("")

    deadlines = analysis.get("deadlines") or []
    lines.append("## Mentioned Dates / Deadlines")
    if deadlines:
        for d in deadlines:
            lines.append(f"- {d}")
    else:
        lines.append("- None detected beyond action-item deadlines.")
    lines.append("")

    sentiment = analysis.get("sentiment") or {}
    if sentiment:
        lines.append("## Meeting Tone (Sentiment)")
        lines.append(
            f"- Overall: **{sentiment.get('label', 'N/A')}** "
            f"(compound score: {sentiment.get('compound', 'N/A')})"
        )
        lines.append("")

    return "\n".join(lines).strip() + "\n"


def format_minutes_plain(analysis: dict[str, Any]) -> str:
    """Plain-text version suitable for download."""
    md = format_minutes_markdown(analysis)
    # Light cleanup for plain text downloads
    text = md.replace("**", "").replace("# ", "").replace("## ", "")
    text = text.replace("| --- | --- | --- |\n", "")
    return text
