// OpenCode's documented before-tool hook provides the real invoking session.
// Never infer ownership from whichever chat happens to be selected in Desktop.
import { browserSession } from './session.mjs';
import { sessionAccess } from './access-policy.mjs';
export default async function browserSessionPlugin({ client, directory } = {}) {
  return {
    'tool.execute.before': async (input, output) => {
      if (/^mesh_enki_images_[a-z0-9_]+$/.test(input.tool)) {
        output.args.__enkiImageContext = browserSession({ engine: 'opencode', sessionID: input.sessionID });
        return;
      }
      if (!/^desktop_browser_browser_[a-z0-9_]+$/.test(input.tool)) return;
      output.args.__arvelaSession = browserSession({ engine: 'opencode', sessionID: input.sessionID });
      // Replace model-supplied access metadata with the actual session policy.
      output.args.__arvelaAccess = client && (await sessionAccess(client, directory, input.sessionID)).full ? 'full' : 'project';
    },
  };
}
