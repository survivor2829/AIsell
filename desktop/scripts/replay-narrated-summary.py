"""Read-only replay of planning input sizes, without model or media requests."""
import argparse
import json
import sqlite3
import sys
from pathlib import Path
from types import MethodType, SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'sidecars' / 'content-engine'))
from content_engine.narrated_batch import NarratedBatchDomain
from content_engine.narrated_sources import representatives, source_index


def size(value):
    return len(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))


def replay(database, batch_id, usage_log=None):
    connection = sqlite3.connect(Path(database).resolve().as_uri() + '?mode=ro', uri=True)
    connection.row_factory = sqlite3.Row
    batch = json.loads(connection.execute('SELECT state_json FROM narrated_batches_v1 WHERE id=?',
                                         (batch_id,)).fetchone()[0])
    domain = SimpleNamespace(db=connection)
    domain._source_evidence_for = MethodType(NarratedBatchDomain._source_evidence_for, domain)
    shots = batch['available_shots']
    before = [{'source_id': f'S{number + 1}', 'observation': shot['description'],
               **domain._source_evidence_for(batch, shot)} for number, shot in enumerate(shots)]
    after, index = source_index(domain, batch)
    refs = set(batch['script_options'][0].get('_draft_source_ids') or index)
    review = [row for row in after if row['source_id'] in refs]
    usage = {}
    usage_path = Path(usage_log) if usage_log else Path(database).parent / 'provider-usage.jsonl'
    usage_available = usage_path.exists()
    if usage_path.exists():
        for line in usage_path.read_text(encoding='utf-8').splitlines():
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if (record.get('batch_id') == batch_id and record.get('call_id')
                    and record.get('started_at', '') <= batch['updated_at']):
                usage[record['call_id']] = record
    historical = list(usage.values())
    asset_count = len({shot['asset_id'] for shot in shots})
    # One grounded call per asset's three representative intervals, then generation + review.
    expected_calls = asset_count + 2
    old_copy_calls = sum(row.get('purpose') in {'文案与需求复核', '文案生成', '文案事实复核'} for row in historical)
    result = {'batch_id': batch_id, 'offline_only': True, 'asset_count': asset_count,
        'interval_count': len(shots), 'representative_intervals': len(representatives(shots)),
        'historical_llm_requests': sum(row.get('kind') == 'llm' for row in historical) if usage_available else None,
        'expected_first_script_llm_requests_with_existing_media_analysis': expected_calls,
        'expected_first_script_llm_requests_with_existing_visual_facts': 2,
        'usage_log_available': usage_available, 'historical_cutoff': batch['updated_at'],
        'old_source_payload_bytes_per_copy_call': size(before),
        'new_generation_source_bytes': size(after), 'new_review_source_bytes': size(review),
        'source_payload_reduction_per_generation': 1 - size(after) / size(before),
        'historical_copy_calls': old_copy_calls if usage_available else None,
        'source_payload_reduction_across_copy_operation': 1 - (size(after) + size(review)) / (size(before) * old_copy_calls) if old_copy_calls else None,
        'historical_known_input_tokens': sum(row.get('input_tokens') or 0 for row in historical) if usage_available else None,
        'historical_input_usage_unknown_calls': sum(row.get('input_tokens') is None for row in historical) if usage_available else None,
        'new_actual_tokens': None, 'new_actual_elapsed_seconds': None, 'verified_amount': None,
        'notes': 'Uses saved source evidence and first existing script references. Request count is a pipeline projection; bytes measure source JSON only. No paid model call, billing claim, video or speed acceptance.'}
    connection.close()
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--database', required=True)
    parser.add_argument('--batch-id', required=True)
    parser.add_argument('--output')
    parser.add_argument('--usage-log')
    args = parser.parse_args()
    report = json.dumps(replay(args.database, args.batch_id, args.usage_log), ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).write_text(report + '\n', encoding='utf-8')
    print(report)
