"""Compact, source-bound planning inputs; full evidence stays in the local cache."""
import math


def representatives(shots):
    selected = []
    for asset_id in dict.fromkeys(shot['asset_id'] for shot in shots):
        rows = sorted((shot for shot in shots if shot['asset_id'] == asset_id),
                      key=lambda shot: shot['source_start_ms'])
        selected.extend(rows[index] for index in sorted({0, len(rows) // 2, len(rows) - 1}))
    return selected


def source_index(domain, batch, shots=None):
    summary = shots is None
    shots = batch['available_shots'] if summary else shots
    observed = {shot['segment_id'] for shot in representatives(shots)} if summary else None
    sources, index = [], {}
    for number, shot in enumerate(shots, 1):
        key = f'S{number}'
        evidence = domain._source_evidence_for(batch, shot)
        facts = (shot.get('visual_facts') or {}) if observed is None or shot['segment_id'] in observed else {}
        source = {'source_id': key, 'asset_id': shot['asset_id'],
                  'range_ms': [shot['source_start_ms'], shot['source_end_ms']]}
        if facts:
            source.update(observation=facts.get('observation', ''),
                          observed_at_ms=facts.get('frame_timestamps_ms', []),
                          evidence_class=facts.get('evidence_class', 'unknown'))
        else:
            source['observation'] = ''  # General analysis captions are not visual proof.
        speech = evidence.get('recorded_speech') or []
        if speech:
            source['recorded_speech'] = [{'id': row['segment_id'], 'text': row['text'],
                'range_ms': [row['source_start_ms'], row['source_end_ms']]} for row in speech]
        if evidence.get('source_provenance'):
            source['source_provenance'] = {key: evidence['source_provenance'][key]
                                           for key in ('authority', 'activity_label')}
        if evidence.get('material_name'):
            source['material_name'] = evidence['material_name']
        # Empty intervals add no script evidence. Their full timeline is retained for editing.
        if facts or speech or source.get('source_provenance'):
            sources.append(source)
            index[key] = shot
    return sources, index


def related_shots(domain, batch, candidate):
    """Keep cited footage and enough neighbouring capacity for the requested duration."""
    all_shots = batch['available_shots']
    cited = {shot['segment_id'] for shot in candidate.get('shots', [])}
    sources, index = source_index(domain, batch, all_shots)
    speech_by_shot = {index[source['source_id']]['segment_id']: ' '.join(row['text'] for row in source.get('recorded_speech', [])) for source in sources}
    narration = candidate.get('narration', '')
    tokens = {narration[i:i + 2] for i in range(max(0, len(narration) - 1))}
    def relevance(shot):
        text = speech_by_shot.get(shot['segment_id'], '') + shot.get('description', '')
        return (shot['segment_id'] in cited, sum(token in text for token in tokens))
    # Bound mapping to duration, with spare footage for a repair, rather than every interval.
    seconds = max((candidate.get('estimated_duration_ms') or 0) / 1000,
                  (batch.get('settings') or {}).get('minimum_duration_seconds', 30))
    limit = min(40, max(12, math.ceil(seconds / 3) * 2))
    selected = sorted(all_shots, key=relevance, reverse=True)[:limit]
    return sorted(selected, key=lambda shot: (shot['asset_id'], shot['source_start_ms']))
