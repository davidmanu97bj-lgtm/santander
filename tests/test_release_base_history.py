"""Regression: locally generated release files are new, not GitHub deletions.
All repositories below are temporary local fixtures. No remote/cloud operations.
"""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('safe_overlay_history', Path(__file__).resolve().parents[1]/'tools/safe-release-overlay.py')
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)


class ReleaseBaseHistory(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root/'source'
        self.target = self.root/'repo'
        self.source.mkdir(); self.target.mkdir()
        self.git('init', '-q', '-b', 'main')
        self.git('config', 'user.name', 'Local fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        (self.target/'app.js').write_text('original')
        self.commit('original ZIP')
        self.base = self.git('rev-parse', 'HEAD').strip()
        (self.source/'app.js').write_text('release')
        (self.source/'financial-store.js').write_text('new ledger module')
        self.manifest = {'schemaVersion': 2, 'originalGitCommit': self.base,
            'absentFromOriginal': ['financial-store.js'],
            'files': {'app.js': [mod.digest(self.target/'app.js')],
                      # Presence in another delivered ZIP is NOT presence in Git.
                      'financial-store.js': [mod.digest(self.source/'financial-store.js')]}}

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.target), *args], check=True,
                              capture_output=True, text=True).stdout

    def commit(self, message):
        self.git('add', '-A'); self.git('commit', '-qm', message)

    def test_first_install_allows_new_file_known_only_from_local_release(self):
        result = mod.overlay(self.source, self.target, self.manifest, True)
        self.assertTrue(result['ok'], result)
        self.assertEqual((self.target/'financial-store.js').read_text(), 'new ledger module')
        self.assertEqual((self.target/'app.js').read_text(), 'release')

    def test_deleted_original_stays_blocked(self):
        (self.target/'app.js').unlink(); self.commit('delete original')
        result = mod.overlay(self.source, self.target, self.manifest, True)
        self.assertFalse(result['ok'])
        self.assertFalse((self.target/'financial-store.js').exists())
        self.assertFalse((self.target/'app.js').exists())

    def test_false_addition_declaration_cannot_override_original_git_tree(self):
        self.manifest['absentFromOriginal'].append('app.js')
        (self.target/'app.js').unlink(); self.commit('delete original')
        self.assertFalse(mod.overlay(self.source, self.target, self.manifest, True)['ok'])

    def test_new_file_added_then_deleted_after_base_stays_blocked(self):
        p = self.target/'financial-store.js'
        p.write_text('new ledger module'); self.commit('install predecessor')
        p.unlink(); self.commit('intentional deletion')
        result = mod.overlay(self.source, self.target, self.manifest, True)
        self.assertFalse(result['ok'])
        self.assertIn('tuvo cambios en Git', '\n'.join(result['conflicts']))
        self.assertEqual((self.target/'app.js').read_text(), 'original')
        self.assertFalse(p.exists())

    def test_deleted_new_file_from_merged_branch_stays_blocked(self):
        self.git('checkout', '-qb', 'feature')
        p = self.target/'financial-store.js'
        p.write_text('new ledger module'); self.commit('add on feature')
        p.unlink(); self.commit('remove on feature')
        self.git('checkout', '-q', 'main')
        (self.target/'remote-only.txt').write_text('keep'); self.commit('main progresses')
        self.git('merge', '--no-ff', '-m', 'merge feature', 'feature')
        self.assertFalse(mod.overlay(self.source, self.target, self.manifest, True)['ok'])

    def test_new_file_renamed_after_base_stays_blocked(self):
        p = self.target/'financial-store.js'
        p.write_text('new ledger module'); self.commit('install')
        p.rename(self.target/'renamed.js'); self.commit('rename')
        self.assertFalse(mod.overlay(self.source, self.target, self.manifest, True)['ok'])
        self.assertTrue((self.target/'renamed.js').exists())

    def test_unknown_remote_edit_is_not_overwritten(self):
        (self.target/'app.js').write_text('new Codex work'); self.commit('new work')
        result = mod.overlay(self.source, self.target, self.manifest, True)
        self.assertFalse(result['ok'])
        self.assertEqual((self.target/'app.js').read_text(), 'new Codex work')
        self.assertFalse((self.target/'financial-store.js').exists())

    def test_unrelated_remote_additions_are_preserved(self):
        (self.target/'remote-only.txt').write_text('keep'); self.commit('unrelated addition')
        self.assertTrue(mod.overlay(self.source, self.target, self.manifest, True)['ok'])
        self.assertEqual((self.target/'remote-only.txt').read_text(), 'keep')

    def test_reinstall_and_committed_install_are_idempotent(self):
        self.assertTrue(mod.overlay(self.source, self.target, self.manifest, True)['ok'])
        self.commit('install package')
        first = {p: mod.digest(self.target/p) for p in ('app.js', 'financial-store.js')}
        self.assertTrue(mod.overlay(self.source, self.target, self.manifest, True)['ok'])
        self.assertEqual(first, {p: mod.digest(self.target/p) for p in first})

    def test_missing_addition_metadata_fails_closed(self):
        self.manifest['absentFromOriginal'] = []
        self.assertFalse(mod.overlay(self.source, self.target, self.manifest, True)['ok'])
        self.assertFalse((self.target/'financial-store.js').exists())

    def test_read_only_does_not_change_clone(self):
        self.assertTrue(mod.overlay(self.source, self.target, self.manifest)['ok'])
        self.assertFalse((self.target/'financial-store.js').exists())
        self.assertEqual(self.git('status', '--porcelain'), '')

    def test_shallow_history_fails_closed(self):
        clone = self.root/'shallow'
        subprocess.run(['git', 'clone', '-q', '--depth', '1', self.target.as_uri(), str(clone)], check=True)
        with self.assertRaisesRegex(ValueError, 'incompleto'):
            mod.overlay(self.source, clone, self.manifest, True)
        self.assertFalse((clone/'financial-store.js').exists())

    def test_unrelated_base_is_rejected(self):
        self.git('checkout', '--orphan', 'unrelated')
        (self.target/'different.txt').write_text('different'); self.commit('other root')
        with self.assertRaisesRegex(ValueError, 'no desciende'):
            mod.overlay(self.source, self.target, self.manifest, True)
        self.assertFalse((self.target/'financial-store.js').exists())

    def test_invalid_commit_is_rejected(self):
        self.manifest['originalGitCommit'] = 'main'
        with self.assertRaisesRegex(ValueError, 'válido'):
            mod.overlay(self.source, self.target, self.manifest, True)

    def test_commit_gate_accepts_existing_trailing_spaces(self):
        (self.target/'rules.txt').write_text('allow read;   \n')
        self.git('add', '--', 'rules.txt')
        command = ['git', '-C', str(self.target), '-c', 'core.whitespace=-blank-at-eol',
                   'diff', '--cached', '--check']
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        script = (Path(__file__).resolve().parents[1]/'tools/cloudshell-release.sh').read_text()
        self.assertIn('git -c core.whitespace=-blank-at-eol diff --cached --check', script)

    def test_commit_gate_still_rejects_conflict_markers(self):
        (self.target/'conflict.txt').write_text('<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> incoming\n')
        self.git('add', '--', 'conflict.txt')
        result = subprocess.run(['git', '-C', str(self.target), '-c', 'core.whitespace=-blank-at-eol',
                                 'diff', '--cached', '--check'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('conflict marker', result.stdout)

    def test_failure_writes_a_report_without_copying(self):
        manifest = self.root/'manifest.json'
        self.manifest['originalGitCommit'] = '0'*40
        manifest.write_text(json.dumps(self.manifest))
        report = self.root/'comparacion.json'
        result = subprocess.run(['python3', str(SPEC.origin), '--source', str(self.source),
            '--target', str(self.target), '--manifest', str(manifest), '--report', str(report), '--apply'],
            capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(json.loads(report.read_text())['ok'])
        self.assertFalse((self.target/'financial-store.js').exists())


if __name__ == '__main__':
    unittest.main()
