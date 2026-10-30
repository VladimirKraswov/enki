# Enki 2.0.21 — проекты, браузер и доступный runner

W `.local/pi-sdk-migration-20261024/review`; R `/Volumes/Extend/work/Enki`.
H42 `../stabilize-v42`. Prior18 UIinstalled/Hub/main7dbc926, native16 retained.
Nevertouch R/untracked opencode.json, ownerhistories/keys/independentCLIs.
No Terminal/SecurityAgent GUI, noGPU, noownerprompts or taskinterruptions.

## Proven

User30Oct23:23 empty worktreeprojects andbrowserUNAVAILABLE.
Catalog306rows,251live (247archive,2pi,1pi-cli,1continuation),55tombstones.
AllliveSmartProLab/worktrees rows absent: owner alreadydeletedthem. UIprojects
cached; control.selectDirectory calledaddProjectDirectory forunknownpath ->pins!
Now controlselection onlysetDirectory; create/deleteevents debouncecatalogrefresh
andfenceoldHTTP. Onceperworkspace emptyoldnative-linkedUUIDpins verifiedwith
exactruntime.listSessions(limit1) ->hiddenProjects (reversible), nofolder/sessiondelete.
Explicitemptyfolders(no nativepointer),legacyrefs,selected,workshop preserved.

BrowsernativeMCP initializepassed buttools/list HTTP400. Realisolateddaemon
regressionoldsource40workspaces failsatindex32; legacy.connectionsperworkspacecap32.
Nowmetadatausesfixedprivateworkspace/projectscope, actualactionskeepexactroots.
New40discoverytest passes36tools,1backend,0browseractions,0browserprofiles.
Oldcodefailed32saveddiscovery-before.log. TestscriptCLIoptionalold_daemon allows
regressionwithoutresettingGit. Pi before_agent_start waitsdetacheddiscovery;
onefailure recovery, noactionretry. RealSDKscriptedprovider firstprompt seesand
executesbrowsertool exactlyonce: sdk-browser.log pass. NoGPU/modelrequest.
NewbrowserTaskpreflight before chatcreation +sharedflight +selectionfence.

## Owner current

Native16/UI18 initiallyoneGUI; endpoint127.0.0.1:61240. BusySmartProLabchat.
Refreshedprojects read-only, thennormalBrowserSettings Stop->enable (restored
originalenabled). No selectedbrowserpagewasopen. ActualnativeMCP now36tools/398ms;
UI saysИнструментыготовы/serviceготов. Noagentstops/prompts. Old44pinnedempty
projectbuttons remain untilnewcleanupcodeinstalled; deletedworktreeprojectrows0.

## Checks / next

Focused72tests4files pass (sidebar,pi-browser,store-regressions,control-focus),
plusprevious75tests inclbrowser-integration. SDKfirst-turnintegration1pass.
Typechecks running/pending latest; exactApp/rootresources nativeFPCHANGED,
so UIhot18 alonecannotdeliver browserdaemonfix! Needcanonicalrelease19,
Hubbothsignedexact, mainpush, native19build/qualifiedCI thenordinaryinstall
atidle. Preserveownerwork. Rootpolicyinstallonlyauthoritativeidle. Ifuserdecision
needed, prepare/concretelyverifythebuild first beforeasking. Do NOTpatchsigned
app or managedbrowsercurrent byhand: installed_at hashesbundledscripts.
Review tests/docsdiff, commitclean, release:local stable no skippedgates;
useexistingR/src-tauri/targetcache, preserveit. OwnTMP enki-stabilize-v42.

Extra evidence: repeated titles in live imported history allhave different original
legacyId (samearchive); NOTduplicateimports, donotdelete/dedupbytitle.
Browser service restoredviaUI Stop(enabledfalse)->enabletrue. Actual36tools398ms.
NewinventorySessionoutside32chatbudget; nochat/pageallocationonmetadata.

## Delivery issue / current20

19canonicalPASS1204UI/411runtime/280Rust+12runner; Hub/main1a76cc4 verified.
CI41127061535 Macjob124308701908 CANCELLED BEFORErunner(no steps).
Officialcheckannotation: scheduledmacOS14brownout Oct30 14:00UTC-Oct31 00:00UTC,
retirementNov2. https://github.com/actions/runner-images/issues/13518.
Officialrunner-imagesREADME confirms macos-14 and macos-15 bothARM64.
ChangedONLYworkflow runner to macos-15 +version20/docs. NativeFP20equals19;
source19mustnotbeoverwritten(signed/immutableversion), sofullrelease20required.
Next: canonical220/verifybothsigned/mainpush/qualifiedCI20, thenordinarynative20
installatidle (ownerwasIDLE in status-published.private.txt; recheckbeforeinstall).
Currentnative16/UI18unchanged, browserrestored36tools. Noownprompts/stops.
Old44pinnedemptyprojects cleanedonlywhen20nativeinstalled. Cleanupisreversible.

## Current21: realChromium cleanup defect discovered before native installation

20canonicalPASS1204UI/411runtime/280Rust+12runner, Hub/main710bb2c verified.
20qualifieddispatch NOTstarted; onlyautomaticpushCI mayrun. 19CIcancelledours.
Manualreal browser preferences.mjs (isolated profiles/localhost) actualactions
ALLpassed, but unchangedassert temporaryprofiledeletedbeforedaemonexit FAILED
(real-browser-action.log). Oldcleanup swallowedfsrm errors/reliedoneventtiming.
Newdaemon tracks ONLYitscreatedtemporaryprofiles inSet; boundedfsrm retries5x100,
finalexplicitcleanupbeforeexit; cleanupfailureexit1insteadfakeclean0. Noowners'
oldprofiles/tokens/dirs scannedordeleted. Realtestsameassertions nowPASS
(real-browser-action-cleanup.log): locale/timezone/privacy/serviceworkers/pacing,
restart/privateauthnotreused/persistentstoragepreserved. Noownerbrowseractions.
Fullnativeinstall stillrequired, version21 includesallprojects/browserfixes.
Nextcanonical221/Hubmain/qualifiedCI21supportedmacos15->ordinaryinstallatidle;
ownercurrentlyIDLE(laststatus). Currentnative16/UI18/browser36toolshealthy.
DoNOTclaiminstalled20/21 orcleanupold44pinsuntilnativeinstalled+AXverified.
