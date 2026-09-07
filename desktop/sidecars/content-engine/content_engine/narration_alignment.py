"""Keep the approved copy while using only observed ASR time boundaries."""

import re
from difflib import SequenceMatcher
from .errors import ContentEngineError


def spoken_key(text):
    return "".join(char.casefold() for char in str(text or "") if char.isalnum())


def _observed_clause_spans(text, units, duration_ms):
    """Keep clause timing when a small ASR omission prevents word-level alignment.

    Both edges must be exact lexical anchors on observed word boundaries.
    Internal differences get one whole cue; no timestamp is invented for them.
    """
    expected = spoken_key(text)
    recognized = "".join(spoken_key(unit.get("text")) for unit in units)
    if not expected or not recognized:
        return []
    matcher = SequenceMatcher(None, expected, recognized, autojunk=False)
    if matcher.ratio() < .95:
        return []
    mapping = {a + offset: b + offset for a, b, count in matcher.get_matching_blocks() for offset in range(count)}
    starts, ends, cursor, previous_end = {}, {}, 0, 0
    for unit in units:
        count = len(spoken_key(unit.get("text")))
        if not count:
            continue
        try:
            start, end = int(unit["start_ms"]), int(unit["end_ms"])
            confidence = float(unit.get("confidence", 1))
        except (KeyError, TypeError, ValueError):
            return []
        if not 0 <= previous_end <= start < end <= duration_ms or confidence < .75:
            return []
        starts[cursor], ends[cursor + count - 1] = start, end
        cursor, previous_end = cursor + count, end
    clauses = re.findall(r"[^，。！？；,!?;]+[，。！？；,!?;]*", text)
    result, cursor, previous_end = [], 0, 0
    for clause in clauses:
        count = len(spoken_key(clause))
        if not count:
            return []
        start = starts.get(mapping.get(cursor))
        end = ends.get(mapping.get(cursor + count - 1))
        if start is None or end is None or not previous_end <= start < end:
            return []
        result.append({"text": clause, "start_ms": start, "end_ms": end})
        cursor, previous_end = cursor + count, end
    return result if "".join(item["text"] for item in result) == text else []


def _aligned_units(text, units, duration_ms):
    positions = [index for index, char in enumerate(text) if char.isalnum()]
    if not positions or spoken_key(text) != "".join(spoken_key(unit.get("text")) for unit in units):
        return []
    result, offset, previous_end = [], 0, 0
    for index, unit in enumerate(units):
        count = len([char for char in str(unit.get("text") or "") if char.isalnum()])
        if not count:
            continue
        try:
            start, end = int(unit["start_ms"]), int(unit["end_ms"])
            confidence = float(unit.get("confidence", 1))
        except (KeyError, TypeError, ValueError):
            return []
        if not 0 <= previous_end <= start < end <= duration_ms or confidence < 0.75:
            return []
        next_offset = offset + count
        if next_offset > len(positions):
            return []
        source_start = 0 if offset == 0 else positions[offset]
        source_end = positions[next_offset] if next_offset < len(positions) else len(text)
        result.append({"text": text[source_start:source_end], "start_ms": start, "end_ms": end})
        offset, previous_end = next_offset, end
    return result if offset == len(positions) else []


def align_narration(text, segments, duration_ms):
    """Exact lexical alignment; punctuation is always taken from the source."""
    text, duration_ms = str(text or ""), int(duration_ms)
    sentence_units, word_units = [], []
    for segment in segments or []:
        if not isinstance(segment, dict):
            continue
        sentence_units.append({"text": segment.get("transcript") or segment.get("text"),
                               "start_ms": segment.get("start_ms"), "end_ms": segment.get("end_ms")})
        for word in (segment.get("metadata") or {}).get("words") or segment.get("words") or []:
            if not isinstance(word, dict) or not spoken_key(word.get("text")):
                continue
            word_units.append({"text": word.get("text"),
                               "start_ms": word.get("begin_time", word.get("start_ms")),
                               "end_ms": word.get("end_time", word.get("end_ms")),
                               "confidence": word.get("confidence", 1)})
    words = _aligned_units(text, word_units, duration_ms)
    sentences = _aligned_units(text, sentence_units, duration_ms)
    spans = _observed_clause_spans(text, word_units, duration_ms) if not words and not sentences else []
    if words:
        # ASR sentence segmentation may differ from the approved punctuation.
        # Word boundaries let us retain the author's sentence boundaries too.
        sentences = []
        current = []
        for word in words:
            current.append(word)
            if re.search(r"[。！？!?；;]\s*$", word["text"]):
                sentences.append({"text": "".join(item["text"] for item in current),
                                  "start_ms": current[0]["start_ms"], "end_ms": current[-1]["end_ms"]})
                current = []
        if current:
            sentences.append({"text": "".join(item["text"] for item in current),
                              "start_ms": current[0]["start_ms"], "end_ms": current[-1]["end_ms"]})
    return {"version": 2, "source": "asr_words" if words else "asr_sentences" if sentences else "asr_spans" if spans else "phrase",
            "matched": bool(words or sentences or spans), "words": words,
            "sentences": sentences or spans or [{"text": text, "start_ms": 0, "end_ms": duration_ms}]}


def attach_narration_alignment(captions, phrase_audio):
    for caption, item in zip(captions, phrase_audio):
        alignment = (item.get("verification") or {}).get("alignment")
        if not isinstance(alignment, dict):
            alignment = align_narration(caption.get("text"), [], item["duration_ms"])
        base = int(caption["start_ms"])
        caption["alignment"] = {**alignment, **{
            key: [{**unit, "start_ms": base + int(unit["start_ms"]), "end_ms": base + int(unit["end_ms"])}
                  for unit in alignment.get(key) or []] for key in ("words", "sentences")}}
        caption["shot_timing_source"] = item.get("shot_timing_source") or "phrase"
        if item.get("sentence_shots"):
            caption["sentence_shots"] = [{**unit, "start_ms": base + int(unit["start_ms"]),
                                         "end_ms": base + int(unit["end_ms"])}
                                        for unit in item["sentence_shots"]]
    return captions


def rebind_sentence_copy(old_text, new_text, sentences):
    if not sentences or ''.join(s.get('text', '') for s in sentences) != old_text:
        return []
    operations = SequenceMatcher(None, old_text, new_text, autojunk=False).get_opcodes()
    edges, cursor = [0], 0
    for sentence in sentences[:-1]:
        cursor += len(sentence['text'])
        mapped = None
        for tag, a, end_a, b, end_b in operations:
            if cursor == a:
                mapped = b
                break
            if cursor == end_a:
                mapped = end_b
                break
            if a < cursor < end_a and tag == 'equal':
                mapped = b + cursor - a
                break
        if mapped is None or mapped <= edges[-1]:
            return []
        edges.append(mapped)
    edges.append(len(new_text))
    return [{**sentence, 'text': new_text[a:b]} for sentence,a,b in zip(sentences,edges,edges[1:])] if all(a<b for a,b in zip(edges,edges[1:])) else []


def aligned_binding_spans(phrase, audio):
    bindings = phrase.get('sentenceBindings') or []
    alignment = (audio.get('verification') or {}).get('alignment') or {}
    if not bindings or not alignment.get('matched'):
        return []
    units = alignment.get('words') or alignment.get('sentences') or []
    result, cursor = [], 0
    for binding in bindings:
        target, collected, start = spoken_key(binding.get('text')), '', cursor
        while cursor < len(units) and len(collected) < len(target):
            collected += spoken_key(units[cursor]['text'])
            cursor += 1
        if not target or collected != target or cursor == start:
            return []
        result.append({'text':binding['text'], 'start_ms':units[start]['start_ms'], 'end_ms':units[cursor-1]['end_ms']})
    return result if cursor == len(units) else []


def sentence_shot_budgets(phrase, audio, segments, pause_ms):
    """Return budgets only when exact sentence and contiguous shot bindings agree."""
    bindings = phrase.get("sentenceBindings") or []
    alignment = (audio.get("verification") or {}).get("alignment") or {}
    sentences = aligned_binding_spans(phrase, audio)
    if not alignment.get("matched") or not bindings or len(bindings) != len(sentences):
        return None
    cursor, result = 0, []
    for index, (binding, sentence) in enumerate(zip(bindings, sentences)):
        refs = binding.get("evidenceRefs") or []
        group = segments[cursor:cursor + len(refs)]
        if (spoken_key(binding.get("text")) != spoken_key(sentence.get("text"))
                or not refs or refs != [segment["evidence_ref"] for segment in group]):
            return None
        start = 0 if index == 0 else int(sentence["start_ms"])
        end = int(sentences[index + 1]["start_ms"]) if index + 1 < len(sentences) else int(audio["duration_ms"]) + pause_ms
        available = sum(int(segment["target_duration_ms"]) for segment in group)
        budget = end - start
        if budget <= 0 or budget > available:
            return None
        accumulated, allocated = 0, 0
        for segment in group:
            accumulated += int(segment["target_duration_ms"])
            boundary = round(budget * accumulated / available)
            value = boundary - allocated
            if value <= 0 or value > int(segment["target_duration_ms"]):
                return None
            result.append(value)
            allocated = boundary
        cursor += len(group)
    return result if cursor == len(segments) else None


def reference_caption_cues(captions, base=0, max_width=26):
    """Pages change at observed word/sentence boundaries, never guessed fractions."""
    cues = []
    for caption in captions:
        alignment = caption.get("alignment") or {}
        words = alignment.get("words") or []
        if alignment.get("source") == "asr_words" and words:
            groups, current, width = [], [], 0.0
            for word in words:
                word_width = sum(0.55 if ord(char) < 128 else 1 for char in word["text"])
                if current and width + word_width > max_width:
                    groups.append(current)
                    current, width = [], 0.0
                current.append(word)
                width += word_width
                if re.search(r"[，。！？；,!?;]\s*$", word["text"]):
                    groups.append(current)
                    current, width = [], 0.0
            if current:
                groups.append(current)
            units = [{"text": "".join(word["text"] for word in group),
                      "start_ms": group[0]["start_ms"], "end_ms": group[-1]["end_ms"],
                      "timing_source": "asr_words"} for group in groups]
        else:
            units = [{**unit, "timing_source": alignment.get("source") or "phrase"}
                     for unit in alignment.get("sentences") or [caption]]
        for unit in units:
            width = sum(0.55 if ord(char) < 128 else 1 for char in unit["text"] if not char.isspace())
            if width > 42:
                raise ContentEngineError("narrated_caption_timing_insufficient",
                    "语音识别没有给出足够细的字幕时间，这句话过长，无法清楚排成两行。请将该段改短后重新确认，正文未被自动修改。")
            cues.append({"text": unit["text"], "start_ms": max(0, int(unit["start_ms"]) - base),
                         "end_ms": max(1, int(unit["end_ms"]) - base),
                         "timing_source": unit["timing_source"]})
    return cues
