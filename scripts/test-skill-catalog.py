#!/usr/bin/env python3
import importlib.util
import json
import os
import sys
sys.dont_write_bytecode = True
import tempfile
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / 'src-tauri/resources/skills/create-shared-skill/scripts/catalog.py'
spec = importlib.util.spec_from_file_location('catalog', SOURCE)
catalog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalog)

class Catalogue(unittest.TestCase):
    def test_scope_override_disabled_and_no_server_credentials(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); project = root / 'project'; project.mkdir()
            (root/'global.json').write_text(json.dumps({'version':1,'sources':[{'id':'same','path':str(root/'global'),'enabled':True},{'id':'enabled','path':str(root/'common'),'enabled':True}], 'servers':[{'secret':'MUST_NOT_EMIT'}]}))
            (root/(catalog.project_key(project)+'.json')).write_text(json.dumps({'version':1,'sources':[{'id':'same','path':str(root/'override'),'enabled':False}]}))
            self.assertEqual(catalog.registry_sources(root,project),[root/'common'])
    def test_identity_revision_and_dedup_without_executing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); skill = root/'download'; skill.mkdir()
            file = skill/'SKILL.md'; file.write_text('---\nname: download\ndescription: Fetch public documents\n---\nBody\n')
            (skill/'scripts').mkdir(); (skill/'scripts/unsafe.py').write_text('raise Exception("must not execute")')
            records = catalog.inventory([root,root]); self.assertEqual(len(records),1)
            self.assertEqual(records[0]['name'],'download'); self.assertEqual(records[0]['path'],str(file.resolve()))
            old = records[0]['sha256']; file.write_text(file.read_text()+'Fix\n')
            self.assertNotEqual(catalog.inventory([root])[0]['sha256'],old)
    def test_invalid_registry_is_explicit_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root/'global.json').write_text('{broken')
            with self.assertRaises(ValueError): catalog.registry_sources(root,None)
    def test_explicit_profile_never_reads_the_owner_home_or_registry(self):
        with tempfile.TemporaryDirectory() as tmp:
            # Physical fixture root: on macOS the temp dir lies below the /var
            # link, which the native profile policy (and now this helper) refuses.
            tmp = Path(tmp).resolve()
            home = Path(tmp)/'home'; profile = Path(tmp)/'profile'
            for windows in (False, True):
                registry, roots = catalog.locations({'ENKI_PROFILE_DIR': str(profile), 'XDG_DATA_HOME': str(home/'xdg')}, home, windows)
                self.assertEqual(registry, profile/'capabilities'); self.assertEqual(roots, [])
            # Invalid profile identity fails closed instead of using owner defaults.
            for bad in ('', 'relative/profile', str(profile/'..'/'x'), str(home)):
                with self.assertRaises(ValueError): catalog.locations({'ENKI_PROFILE_DIR': bad}, home, False)
    def test_default_registry_matches_the_native_root_on_every_platform(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            registry, roots = catalog.locations({'LOCALAPPDATA': str(home/'AppData/Local')}, home, True)
            self.assertEqual(registry, home/'.enki/capabilities'); self.assertEqual(roots, [home/'.agents/skills'])
            (home/'.opencode-desktop/capabilities').mkdir(parents=True)
            self.assertEqual(catalog.locations({}, home, True)[0], home/'.opencode-desktop/capabilities')
            self.assertEqual(catalog.locations({'XDG_DATA_HOME': 'relative'}, home, False)[0], home/'.local/share/enki/capabilities')
            self.assertEqual(catalog.locations({'XDG_DATA_HOME': str(home/'xdg')}, home, False)[0], home/'xdg/enki/capabilities')
    def link(self, target, at):
        try:
            os.symlink(target, at, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest('this host cannot create directory links for the fixture')
    def test_linked_profiles_and_physical_home_aliases_fail_closed_like_native(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp).resolve()
            home = tmp/'home'; other = tmp/'other-profile'; real = tmp/'real'
            for directory in (home, other/'capabilities', real):
                directory.mkdir(parents=True)
            (other/'capabilities/global.json').write_text(json.dumps({'version': 1, 'sources': [{'id': 'x', 'path': str(tmp/'x'), 'enabled': True}]}))
            self.link(other, tmp/'profile-link')             # linked profile → another profile's registry
            self.link(real, tmp/'ancestor-link')             # linked ancestor
            self.link(home, tmp/'home-alias')                # link to HOME
            (tmp/'a-file').write_text('not a directory')
            for bad in (tmp/'profile-link', tmp/'ancestor-link'/'profile', tmp/'home-alias', tmp/'a-file'/'profile'):
                with self.assertRaises(ValueError, msg=str(bad)):
                    catalog.locations({'ENKI_PROFILE_DIR': str(bad)}, home, False)
            # Physical HOME reached without any link component: HOME itself is given through a link.
            with self.assertRaises(ValueError):
                catalog.locations({'ENKI_PROFILE_DIR': str(home)}, tmp/'home-alias', False)
            # A clean own profile still works and resolves to its physical registry.
            own = tmp/'own'; own.mkdir()
            self.assertEqual(catalog.locations({'ENKI_PROFILE_DIR': str(own)}, home, False), (own/'capabilities', []))
    def test_an_inherited_registry_override_never_redirects_an_explicit_profile(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp).resolve()
            home = tmp/'home'; profile = tmp/'profile'; owner = home/'.local/share/enki/capabilities'
            owner.mkdir(parents=True); profile.mkdir()
            (owner/'global.json').write_text(json.dumps({'version': 1, 'sources': [{'id': 'owner', 'path': str(home/'owner-skills'), 'enabled': True}]}))
            registry, roots = catalog.locations({'ENKI_PROFILE_DIR': str(profile), 'MESH_CAPABILITIES_ROOT': str(owner)}, home, False)
            self.assertEqual((registry, roots), (profile/'capabilities', []))
            self.assertEqual(catalog.registry_sources(registry, None), [])
            # Without a profile the existing default override is preserved.
            self.assertEqual(catalog.locations({'MESH_CAPABILITIES_ROOT': str(owner)}, home, False), (owner, [home/'.agents/skills']))
    def test_only_connected_sources_are_reported_as_loaded_by_enki(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for source in ('connected', 'ambient'):
                (root/source/'skill').mkdir(parents=True)
                (root/source/'skill/SKILL.md').write_text(f'---\nname: {source}\ndescription: d\n---\n')
            records = catalog.mark_connected(catalog.inventory([root/'connected', root/'ambient']), [root/'connected'])
            self.assertEqual({r['name']: r['enki'] for r in records}, {'connected': 'connected-source', 'ambient': 'not-loaded'})

if __name__ == '__main__': unittest.main()
