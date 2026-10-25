import {expect,it} from 'vitest';
import {managedPlugins,pluginFileUri} from '../src/util/managedPlugins';
const paths={accessPluginPath:'/enki/capabilities/agent-plugins/abc/access-policy.mjs',browserPluginPath:'/enki/capabilities/agent-plugins/abc/opencode-session-plugin.mjs',retiredAccessPluginPaths:['/old/capabilities/access-policy.mjs','/enki/capabilities/access-policy.mjs'],retiredBrowserPluginPaths:['/old/browser-runtime/current/opencode-session-plugin.mjs']};
it('replaces all verified legacy copies once and preserves foreign plugins and order',()=>{
 const input=['owner-plugin',pluginFileUri(paths.retiredAccessPluginPaths[0]),'file:///foreign/access-policy.mjs',pluginFileUri(paths.retiredAccessPluginPaths[1]),pluginFileUri(paths.retiredBrowserPluginPaths[0])];
 const next=managedPlugins(input,paths,{access:true,browser:false});
 expect(next).toEqual(['owner-plugin',pluginFileUri(paths.accessPluginPath),'file:///foreign/access-policy.mjs',pluginFileUri(paths.browserPluginPath)]);
 expect(managedPlugins(next,paths,{access:true,browser:false})).toEqual(next);expect(input).toHaveLength(5);
 expect(managedPlugins([],paths,{access:true,browser:false})).toEqual([pluginFileUri(paths.accessPluginPath)]);
});
// Retired: "the browser and shared config writers agree on one immutable graph"
// exercised the two OpenCode JSONC writers (sharedOpenCodeConfig, browserConfig),
// both deleted with that engine. src/util/managedPlugins.ts has no production
// importer left; this pure test stays until its source owner removes it.
