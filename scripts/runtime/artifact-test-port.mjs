// Test fixtures only; never imported by the production publisher or installer.
import {setDirectoryFlushPort} from './artifact.mjs';
import {trustedRunner} from './native-port.mjs';
if(process.platform==='win32'){
 if(!process.env.ENKI_TEST_NATIVE_RUNNER)throw Error('Run npm run test:runtime-artifact to bootstrap the real Windows directory-flush port');
 setDirectoryFlushPort(trustedRunner({path:process.env.ENKI_TEST_NATIVE_RUNNER,sha256:process.env.ENKI_TEST_NATIVE_RUNNER_SHA256}));
}
