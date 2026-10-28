# Enki 2.0.18 — изоляция компонентов и уведомлений чата

W `.local/pi-sdk-migration-20261024/review`, R `/Volumes/Extend/work/Enki`.
Evidence H41 `../stabilize-v41`; previous H40 completed UI217, native216.
Do not touch R/untracked opencode.json, histories, keys, independent CLIs.
Owner AX only emit:false + whitelist. No SecurityAgent/Terminal GUI, GPU tests,
model prompts, interruption or resumption of owner tasks.

## Confirmed

Owner screenshots23:46 duplicate MCP notices plus reconnecting stream.
LiveAX five notices. App rendered two different sibling components with SAME key
(directory/session). Regression actualApp beforefix: second switch retains2notices.
Now distinct mcp:/ui: namespace; test7switches expects1notice/1UIconnection,
previous lease disposed, all disposed at unmount. Notices fallback scoped toexact
session ANDdirectory. REA label now specific instead of generic remote-tools.
Actual native sharedMCP REA discovery succeeded27tools/2603ms, no toolcalls.
Atinitialsnapshot directory streamopen/globalreconnecting; causal link between
React defect and stream interruption NOT proved. Preserve existing20s/45s liveness
bounds andcursor replay; evaluate streams again after ordinary signedhotupdate.

## Next

Focusedchecks,typecheck,diffreview. Commitreviewed18, canonical release:local stable
(no skipped gates), verifyHubhead+bothsignedpackets, mainpush. NativeFPunchanged
expected16; ordinary signedhotUI, preserveagents/model/latestselection/histories.
Verify actualAX notices0or1 +streams, cleanup ONLYownbuildtarget afteracceptance.
Never claimCI/nativeinstall orWindows/Linuxlivechecks before proof.
