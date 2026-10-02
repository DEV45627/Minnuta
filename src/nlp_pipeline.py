"""NLP analysis for meeting transcripts."""

from __future__ import annotations

import re
from collections import Counter
from datetime import datetime
from typing import Any

from sklearn.feature_extraction.text import TfidfVectorizer
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

try:
    import spacy
except ImportError:  # pragma: no cover
    spacy = None

_NLP = None
_SENTIMENT = SentimentIntensityAnalyzer()

_STOPWORDS = {
    "a", "about", "above", "after", "again", "against", "all", "am", "an", "and",
    "any", "are", "as", "at", "be", "because", "been", "before", "being", "below",
    "between", "both", "but", "by", "can", "did", "do", "does", "doing", "down",
    "during", "each", "few", "for", "from", "further", "had", "has", "have",
    "having", "he", "her", "here", "hers", "herself", "him", "himself", "his",
    "how", "i", "if", "in", "into", "is", "it", "its", "itself", "just", "me",
    "more", "most", "my", "myself", "no", "nor", "not", "now", "of", "off", "on",
    "once", "only", "or", "other", "our", "ours", "ourselves", "out", "over",
    "own", "same", "she", "should", "so", "some", "such", "than", "that", "the",
    "their", "theirs", "them", "themselves", "then", "there", "these", "they",
    "this", "those", "through", "to", "too", "under", "until", "up", "very",
    "was", "we", "were", "what", "when", "where", "which", "while", "who",
    "whom", "why", "will", "with", "you", "your", "yours", "yourself",
    "yourselves", "also", "ok", "okay", "yes", "well", "let", "lets", "good",
    "great", "thanks", "thank", "everyone", "morning", "joining", "decision",
    "needs", "week", "last", "still",
}

_INVALID_ASSIGNEES = {
    "i", "we", "it", "he", "she", "they", "you", "that", "this", "there",
    "also", "please", "kindly", "someone", "anyone", "everyone", "team",
}

SPEAKER_LINE_RE = re.compile(
    r"^\s*(?P<speaker>[A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s*:\s*(?P<utterance>.+)$"
)

ACTION_VERBS = (
    "prepare", "send", "review", "update", "complete", "finish", "schedule",
    "share", "draft", "create", "submit", "implement", "fix", "measure",
    "increase", "postpone", "report",
)


def get_nlp():
    """Load spaCy English model (lazy). Falls back to blank English if model missing."""
    global _NLP
    if _NLP is not None:
        return _NLP
    if spacy is None:
        raise ImportError("spaCy is required. Install with: pip install spacy")
    try:
        _NLP = spacy.load("en_core_web_sm")
    except OSError:
        _NLP = spacy.blank("en")
        if "sentencizer" not in _NLP.pipe_names:
            _NLP.add_pipe("sentencizer")
    return _NLP


DECISION_PATTERNS = [
    re.compile(
        r"(?i)\b(?:we (?:have )?decided|decision(?: is| made)?|agreed (?:to|that)|"
        r"consensus is|it was agreed|approved|will go with|final decision)\b[^.!?\n]{0,160}"
    ),
]

DEADLINE_PATTERNS = [
    re.compile(
        r"(?i)\b(?:by|before|due|deadline|no later than|until)\s+"
        r"(?P<deadline>"
        r"(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|"
        r"tomorrow|today|next week|end of (?:the )?week|eod|eow|"
        r"\d{1,2}(?:st|nd|rd|th)?\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|"
        r"apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|"
        r"oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
        r"(?:\s+\d{4})?|"
        r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|"
        r"jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|"
        r"dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?)"
        r")"
    ),
    re.compile(
        r"(?i)\b(?P<deadline>tomorrow|today|monday|tuesday|wednesday|thursday|friday|"
        r"saturday|sunday|next week|end of (?:the )?week)\b\s*[.!]?\s*$"
    ),
]


def parse_dialogue(text: str) -> list[dict[str, str]]:
    """Split transcript into speaker turns when labels like 'Alex:' are present."""
    turns = []
    current_speaker = ""
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        match = SPEAKER_LINE_RE.match(line)
        if match:
            current_speaker = match.group("speaker")
            turns.append(
                {"speaker": current_speaker, "text": match.group("utterance").strip()}
            )
        else:
            turns.append({"speaker": current_speaker, "text": line})
    if not turns:
        turns.append({"speaker": "", "text": text.strip()})
    return turns


def clean_task_text(task: str) -> str:
    task = re.sub(r"^[A-Z][a-z]+\s*:\s*", "", task.strip())
    task = re.sub(r"^(?:I |we |they )?(?:will|should|need to|needs to|has to|must)\s+", "", task, flags=re.I)
    return task.strip(" .-:")


def normalize_assignee(name: str, people: list[str]) -> str:
    name = (name or "").strip(" .,:")
    if not name:
        return "Unassigned"
    lower = name.lower()
    if lower in _INVALID_ASSIGNEES or len(name) < 2:
        return "Unassigned"
    for person in people:
        if person.lower() == lower or person.lower() in lower or lower in person.lower():
            return person
    if name[:1].isupper() and name.isalpha():
        return name
    return "Unassigned"


def extract_entities(text: str, known_people: list[str] | None = None) -> dict[str, list[str]]:
    """Named Entity Recognition: people, orgs, dates, places."""
    nlp = get_nlp()
    doc = nlp(text)
    known_people = known_people or []

    people, orgs, dates, places = [], [], [], []
    for ent in getattr(doc, "ents", []):
        label = ent.label_
        value = ent.text.strip()
        if not value or ":" in value:
            continue
        if label == "PERSON":
            people.append(value)
        elif label == "ORG":
            orgs.append(value)
        elif label in {"DATE", "TIME"}:
            # Filter vague/non-deadline date-like tokens
            if value.lower() not in {"morning", "afternoon", "evening", "weekly", "daily", "monthly"}:
                dates.append(value)
        elif label in {"GPE", "LOC", "FAC"}:
            places.append(value)

    # Dialogue speakers are strong participant signals
    for turn in parse_dialogue(text):
        if turn["speaker"]:
            people.append(turn["speaker"])

    def uniq(items: list[str]) -> list[str]:
        seen = set()
        out = []
        for item in items:
            key = item.lower()
            if key in seen or key in _INVALID_ASSIGNEES:
                continue
            seen.add(key)
            out.append(item)
        return out

    merged_people = uniq(known_people + people)
    return {
        "people": merged_people,
        "organizations": uniq(orgs),
        "dates": uniq(dates),
        "places": uniq(places),
    }


def extract_topics(text: str, top_k: int = 8, exclude_names: list[str] | None = None) -> list[str]:
    """Keyword / topic extraction using TF-IDF on sentences."""
    exclude = {n.lower() for n in (exclude_names or [])}
    nlp = get_nlp()
    # Prefer utterance text without speaker labels for topic quality
    utterance_text = " ".join(t["text"] for t in parse_dialogue(text))
    doc = nlp(utterance_text)
    sentences = [s.text.strip() for s in doc.sents if len(s.text.strip()) > 20]
    if len(sentences) < 2:
        tokens = [
            t.lemma_.lower()
            for t in doc
            if t.is_alpha
            and t.lemma_.lower() not in _STOPWORDS
            and t.lemma_.lower() not in exclude
            and len(t) > 2
        ]
        return [w for w, _ in Counter(tokens).most_common(top_k)]

    try:
        vectorizer = TfidfVectorizer(
            stop_words=list(_STOPWORDS),
            ngram_range=(1, 2),
            max_features=500,
            min_df=1,
        )
        matrix = vectorizer.fit_transform(sentences)
        scores = matrix.sum(axis=0).A1
        terms = vectorizer.get_feature_names_out()
        ranked = sorted(zip(terms, scores), key=lambda x: x[1], reverse=True)
        topics = []
        for term, _ in ranked:
            low = term.lower()
            if low in _STOPWORDS or low in exclude:
                continue
            if any(name in low.split() for name in exclude):
                continue
            topics.append(term)
            if len(topics) >= top_k:
                break
        return topics
    except ValueError:
        return []


def extract_action_items(text: str, people: list[str] | None = None) -> list[dict[str, str]]:
    """Identify action items, assignees, and deadlines from the transcript."""
    people = people or []
    people_lower = {p.lower(): p for p in people}
    items: list[dict[str, str]] = []
    seen = set()

    patterns = [
        # "Sam needs to draft ..." / "Jordan should complete ..."
        re.compile(
            r"(?i)\b(?P<person>[A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+"
            r"(?:will|should|needs? to|has to|is going to|must)\s+(?P<task>.+)$"
        ),
        # "I will update ..."
        re.compile(r"(?i)\bI\s+(?:will|should|need to|must)\s+(?P<task>.+)$"),
        # "Please also send ..."
        re.compile(
            r"(?i)\b(?:please|kindly)(?:\s+\w+){0,2}\s+"
            r"(?P<task>(?:prepare|send|review|update|complete|finish|schedule|share|draft|create|submit)\b.+)$"
        ),
        # "action item: ..."
        re.compile(r"(?i)\b(?:action item|todo|to-do|task)[:\-\s]+(?P<task>.+)$"),
    ]

    skip_decision_cues = re.compile(
        r"(?i)\b(?:decided|agreed|approved|consensus|will go with)\b"
    )

    for turn in parse_dialogue(text):
        speaker = turn["speaker"]
        for sentence in re.split(r"(?<=[.!?])\s+", turn["text"]):
            sentence = sentence.strip()
            if len(sentence) < 12:
                continue
            if skip_decision_cues.search(sentence) and not re.search(
                r"(?i)\b(?:I will|needs? to|should complete|should finish|please)\b",
                sentence,
            ):
                continue

            assignee = ""
            task = ""

            # Avoid "It should ..." false positives
            if re.match(r"(?i)^(it|that|this|there)\s+should\b", sentence):
                continue

            for pattern in patterns:
                match = pattern.search(sentence)
                if not match:
                    continue
                groups = match.groupdict()
                task = clean_task_text(groups.get("task") or sentence)
                if "person" in groups and groups.get("person"):
                    assignee = groups["person"]
                elif re.match(r"(?i)^I\s+(?:will|should|need to|must)\b", sentence):
                    assignee = speaker
                break

            if not task:
                lower = sentence.lower()
                if any(v in lower for v in ACTION_VERBS) and any(
                    cue in lower for cue in ("will", "should", "need", "assign", "please")
                ):
                    task = clean_task_text(sentence)
                    for name, original in people_lower.items():
                        if re.search(rf"\b{re.escape(name)}\b", lower):
                            assignee = original
                            break
                    if not assignee and speaker and re.match(r"(?i)^I\b", sentence):
                        assignee = speaker

            if not task:
                continue

            # Skip decision statements and weak non-action sentences
            low_task = task.lower()
            if any(
                x in low_task
                for x in (
                    "go with the",
                    "reduce drop-off",
                    "looks positive",
                    "still needs a review",
                )
            ):
                continue
            if low_task.startswith("the ") and "need" in low_task and not any(
                v in low_task for v in ACTION_VERBS
            ):
                continue

            deadline = "Not specified"
            for pattern in DEADLINE_PATTERNS:
                deadline_match = pattern.search(sentence)
                if deadline_match:
                    deadline = deadline_match.group("deadline").strip()
                    break

            # Prefer named participants mentioned in the sentence
            if assignee.lower() not in people_lower and people:
                for name, original in people_lower.items():
                    if re.search(rf"\b{re.escape(name)}\b", sentence.lower()):
                        # Only override weak assignees
                        if normalize_assignee(assignee, people) == "Unassigned":
                            assignee = original
                        break

            assignee = normalize_assignee(assignee, people)
            key = task.lower()[:90]
            if key in seen or len(task) < 8:
                continue
            seen.add(key)
            items.append(
                {
                    "task": task[:200],
                    "assignee": assignee,
                    "deadline": deadline,
                }
            )

    return items[:12]


def extract_decisions(text: str) -> list[str]:
    """Extract decision-like statements."""
    decisions = []
    seen = set()
    utterance_text = " ".join(t["text"] for t in parse_dialogue(text))
    for pattern in DECISION_PATTERNS:
        for match in pattern.finditer(utterance_text):
            decision = match.group(0).strip(" .-:")
            key = decision.lower()
            if key not in seen and len(decision) > 15:
                seen.add(key)
                decisions.append(decision[:250])
    return decisions[:10]


def extract_discussion_points(text: str, max_points: int = 8) -> list[str]:
    """Select informative sentences as main discussion points."""
    nlp = get_nlp()
    points_src = [t["text"] for t in parse_dialogue(text)]
    joined = " ".join(points_src)
    doc = nlp(joined)
    sentences = [s.text.strip() for s in doc.sents if len(s.text.strip()) > 40]
    if not sentences:
        return []

    scored = []
    for sent in sentences:
        score = len(sent.split())
        if "?" in sent:
            score *= 0.7
        if any(
            w in sent.lower()
            for w in ("discuss", "review", "plan", "issue", "update", "progress", "roadmap", "migration")
        ):
            score *= 1.35
        # Down-rank pure action reminders so discussion stays distinct
        if re.search(r"(?i)\bI will\b", sent):
            score *= 0.8
        scored.append((score, sent))

    scored.sort(key=lambda x: x[0], reverse=True)
    points = []
    seen = set()
    for _, sent in scored:
        key = sent.lower()[:60]
        if key in seen:
            continue
        seen.add(key)
        points.append(sent)
        if len(points) >= max_points:
            break
    return points


def summarize_text(text: str, max_sentences: int = 5) -> str:
    """Extractive summary: top TF-IDF sentences in original order."""
    nlp = get_nlp()
    utterance_text = " ".join(t["text"] for t in parse_dialogue(text))
    doc = nlp(utterance_text)
    sentences = [s.text.strip() for s in doc.sents if len(s.text.strip()) > 25]
    if not sentences:
        return text[:500]
    if len(sentences) <= max_sentences:
        return " ".join(sentences)

    vectorizer = TfidfVectorizer(stop_words=list(_STOPWORDS))
    try:
        matrix = vectorizer.fit_transform(sentences)
    except ValueError:
        return " ".join(sentences[:max_sentences])

    scores = matrix.sum(axis=1).A1
    top_idx = sorted(scores.argsort()[-max_sentences:])
    return " ".join(sentences[i] for i in top_idx)


def analyze_sentiment(text: str) -> dict[str, Any]:
    """Optional overall meeting tone analysis."""
    scores = _SENTIMENT.polarity_scores(text)
    compound = scores["compound"]
    if compound >= 0.05:
        label = "Positive"
    elif compound <= -0.05:
        label = "Negative"
    else:
        label = "Neutral"
    return {
        "label": label,
        "compound": round(compound, 3),
        "positive": round(scores["pos"], 3),
        "neutral": round(scores["neu"], 3),
        "negative": round(scores["neg"], 3),
    }


def analyze_transcript(
    text: str,
    meeting_title: str | None = None,
    meeting_date: str | None = None,
    participants: list[str] | None = None,
) -> dict[str, Any]:
    """Run the full NLP pipeline on a meeting transcript."""
    entities = extract_entities(text, known_people=participants or [])
    people = entities["people"]
    topics = extract_topics(text, exclude_names=people)

    return {
        "title": meeting_title or _infer_title(text, topics),
        "date": meeting_date or datetime.now().strftime("%Y-%m-%d"),
        "participants": people,
        "topics": topics,
        "discussion_points": extract_discussion_points(text),
        "decisions": extract_decisions(text),
        "action_items": extract_action_items(text, people),
        "deadlines": entities["dates"],
        "organizations": entities["organizations"],
        "summary": summarize_text(text),
        "sentiment": analyze_sentiment(text),
        "entities": entities,
    }


def _infer_title(text: str, topics: list[str]) -> str:
    if topics:
        return "Meeting on " + ", ".join(t.title() for t in topics[:2])
    first_line = text.strip().split("\n")[0][:60]
    return first_line or "Meeting Minutes"
