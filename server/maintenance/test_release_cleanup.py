import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from release_cleanup import cleanup


class CleanupTest(unittest.TestCase):
    def test_only_completed_duplicates_are_removed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, uploads = Path(temporary) / 'maintenance', Path(temporary) / 'uploads'
            for directory in (root / 'artifacts', root / 'releases/test', uploads):
                directory.mkdir(parents=True)
            # Hosted Windows TEMP can be a junction or short-name alias. The
            # production cleanup intentionally accepts only canonical roots.
            root, uploads = root.resolve(), uploads.resolve()
            content = b'original formal installer'
            digest = hashlib.sha256(content).hexdigest()
            formal = root / 'artifacts' / (digest + '.exe')
            formal.write_bytes(content)
            stages = {}
            for sequence, category in enumerate(('duplicate', 'unique', 'unpublished', 'corrupt', 'recent'), 1):
                stage = uploads / f'ai-release-{sequence}'
                stage.mkdir()
                manifest = dict(schema=1, channel='test', appId='com.aihuoke.desktop.test', sequence=sequence,
                                version=f'1.0.{sequence}', sha256=digest, size=len(content), file=f'/artifacts/{digest}.exe')
                envelope = dict(payload=json.dumps(manifest), signature='isolated history identity')
                (stage / 'installer.exe').write_bytes(content if category != 'corrupt' else b'wrong')
                (stage / 'latest.json').write_text(json.dumps(envelope))
                if category != 'unpublished':
                    (root / f'releases/test/{sequence}.json').write_text(json.dumps(envelope))
                if category == 'unique':
                    (stage / 'recovery.log').write_text('unique failure evidence')
                stages[category] = stage
            preview = cleanup(root, uploads, min_age_seconds=0)
            self.assertEqual(len(preview['candidates']), 2)
            self.assertTrue(all(stage.exists() for stage in stages.values()))
            if os.name == 'posix':
                with patch('release_cleanup.hashlib.file_digest', side_effect=AssertionError('unchanged files were already hashed')):
                    cleanup(root, uploads, min_age_seconds=0, verified_plan=preview)
            changed = stages['duplicate'] / 'installer.exe'
            previous = changed.stat()
            changed.write_bytes(b'x' * len(content))
            os.utime(changed, ns=(previous.st_atime_ns, previous.st_mtime_ns))
            invalidated = cleanup(root, uploads, min_age_seconds=0, verified_plan=preview)
            self.assertNotIn(str(stages['duplicate']), [entry['path'] for entry in invalidated['candidates']])
            changed.write_bytes(content)
            recent = cleanup(root, uploads, apply=True, min_age_seconds=3600)
            self.assertEqual(recent['removed'], [])
            result = cleanup(root, uploads, apply=True, min_age_seconds=0, require_free_bytes=2**63, verified_plan=preview)
            self.assertFalse(result['spaceSufficient'])
            self.assertFalse(stages['duplicate'].exists())
            for category in ('unique', 'unpublished', 'corrupt'):
                self.assertTrue(stages[category].exists())
            self.assertEqual(formal.read_bytes(), content)
            self.assertEqual(len(list((root / 'releases/test').glob('*.json'))), 4)
            self.assertEqual(cleanup(root, uploads, apply=True, min_age_seconds=0)['removed'], [])


if __name__ == '__main__':
    unittest.main()
