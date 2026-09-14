import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC=importlib.util.spec_from_file_location('overlay',Path(__file__).resolve().parents[1]/'tools/safe-release-overlay.py')
mod=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(mod)
class SafeRelease(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.base=Path(self.tmp.name);self.source=self.base/'source';self.target=self.base/'target'
        self.source.mkdir();self.target.mkdir();(self.source/'app.js').write_text('new');(self.target/'app.js').write_text('old')
        self.manifest={'files':{'app.js':[mod.digest(self.target/'app.js')]}}
    def test_applies_known_base_and_preserves_extra_remote_files(self):
        (self.target/'remote-only.txt').write_text('keep')
        self.assertTrue(mod.overlay(self.source,self.target,self.manifest,True)['ok'])
        self.assertEqual((self.target/'app.js').read_text(),'new')
        self.assertEqual((self.target/'remote-only.txt').read_text(),'keep')
    def test_unknown_remote_change_stops_before_copying_anything(self):
        (self.source/'new.txt').write_text('addition');(self.target/'app.js').write_text('Codex newer')
        result=mod.overlay(self.source,self.target,self.manifest,True)
        self.assertFalse(result['ok']);self.assertFalse((self.target/'new.txt').exists())
        self.assertEqual((self.target/'app.js').read_text(),'Codex newer')
    def test_remote_deletion_is_not_automatically_undone(self):
        (self.target/'app.js').unlink()
        self.assertFalse(mod.overlay(self.source,self.target,self.manifest,True)['ok'])
        self.assertFalse((self.target/'app.js').exists())
    def test_same_release_can_be_retried(self):
        mod.overlay(self.source,self.target,self.manifest,True)
        self.assertTrue(mod.overlay(self.source,self.target,self.manifest,True)['ok'])
    def test_symlink_in_source_rejected(self):
        (self.source/'link').symlink_to(self.target/'app.js')
        with self.assertRaises(ValueError):mod.overlay(self.source,self.target,self.manifest,True)
    def test_symlink_in_destination_rejected(self):
        (self.target/'app.js').unlink();(self.target/'app.js').symlink_to(self.source/'app.js')
        with self.assertRaises(ValueError):mod.overlay(self.source,self.target,self.manifest,True)
    def test_secret_source_rejected(self):
        (self.source/'.env').write_text('DO_NOT_SHIP=dummy-test')
        with self.assertRaises(ValueError):mod.overlay(self.source,self.target,self.manifest,True)
    def test_dependencies_and_output_are_not_copied(self):
        for name in ['node_modules','dist','.git','.deploy']:
            (self.source/name).mkdir();(self.source/name/'anything').write_text('test')
        result=mod.overlay(self.source,self.target,self.manifest,True)
        self.assertEqual(result['files'],['app.js'])
    def test_read_only_mode_does_not_change_target(self):
        self.assertTrue(mod.overlay(self.source,self.target,self.manifest)['ok'])
        self.assertEqual((self.target/'app.js').read_text(),'old')
    def test_cannot_overlay_onto_source(self):
        with self.assertRaises(ValueError):mod.overlay(self.source,self.source,self.manifest,True)

if __name__=='__main__':unittest.main()
