import { expect, it } from 'vitest';
import { DEFAULT_PREFS } from '../src/state/prefs';
import { migrateDirectoryPrefs } from '../src/state/directoryMigration';

it('moves saved project, chat and drafts together before reconnect, without touching another host', () => {
 const other={selectedDirectory:'/old/project',drafts:{'new::/old/project':'remote'}};
 const before={...DEFAULT_PREFS,selectedDirectory:'/old/project',pinnedProjects:['/old/project','/new/project'],
  lastSessionByDir:{'/old/project':'chat-id'},drafts:{'chat-id':'same session','new::/old/project':'local draft'},
  modelChoice:{'/old/project':{providerID:'local',modelID:'qwen'}},endpointState:{'ssh:other':other},
  projectlessSessions:[{id:'chat-id',directory:'/old/project',title:'Chat',projectID:'enki',time:{created:1,updated:2}}]};
 const after=migrateDirectoryPrefs(before,{'/old/project':'/new/project'});
 expect(after.selectedDirectory).toBe('/new/project');expect(after.pinnedProjects).toEqual(['/new/project']);
 expect(after.lastSessionByDir).toEqual({'/new/project':'chat-id'});
 expect(after.drafts).toEqual({'chat-id':'same session','new::/new/project':'local draft'});
 expect(after.modelChoice['/new/project'].modelID).toBe('qwen');
 expect(after.projectlessSessions?.[0].directory).toBe('/new/project');
 expect(after.endpointState?.['ssh:other']).toBe(other);
 expect(before.selectedDirectory).toBe('/old/project');
 expect(migrateDirectoryPrefs(after,{'/old/project':'/new/project'})).toEqual(after);
});
it('preserves both unsent drafts, follows successive moves and respects path boundaries',()=>{
 const prefs={...DEFAULT_PREFS,selectedDirectory:'/old/project-2',drafts:{'new::/old/project':'first','new::/new/project':'second'}};
 const moved=migrateDirectoryPrefs(prefs,{'/old/project':'/middle/project','/middle/project':'/new/project'});
 expect(moved.selectedDirectory).toBe('/old/project-2');expect(moved.drafts['new::/new/project']).toBe('second\n\nfirst');
 expect(Object.keys(moved.drafts)).toEqual(['new::/new/project']);
});
it('a cyclic or invalid rename cannot hang or redirect relative preference keys',()=>{
 const prefs={...DEFAULT_PREFS,selectedDirectory:'/a',drafts:{'session:1':'draft'}};
 expect(migrateDirectoryPrefs(prefs,{'/a':'/b','/b':'/a','session:1':'/other'}).selectedDirectory).toBe('/a');
 expect(migrateDirectoryPrefs(prefs,{'session:1':'/other'}).drafts).toEqual(prefs.drafts);
});
