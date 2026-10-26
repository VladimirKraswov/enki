# Диагностика времени задачи

Chat details → **Время и выполнение задачи** shows one already-loaded user
request of an Enki chat (or a read-only archive). It performs no history search, agent requests or
configuration changes. The optional JSON export contains only bounded counters
and provenance, without message text, tool input/output, paths or screenshots.

Desktop queue and preparation are captured before ordinary/queued dispatch;
scheduled dispatch captures preparation (schedule lateness is not a measured
queue). The first response is the first received nonempty text/reasoning event,
not a provider TTFT or assistant-start marker. Full observed time includes
Desktop queue/preparation until an observed end; no result check is inferred.
Archived OpenCode history may carry engine timestamps that provide elapsed
intervals. Runtime (Pi SDK) entry creation/completion timestamps do not establish
generation duration: history-only wall/phase durations of runtime chats stay
unknown; live observation measures them. The echoed user timestamp links
temporary and durable ids only when unique. Observation data is bounded to 100 turns per
loaded chat and is transient until the app exits; Hub's opt-in numeric transfer
can retain it under the existing metadata retention policy.

Tool/reasoning intervals are clipped to the turn and combined by interval union.
Their categories may overlap; they must not be added together. “Вне известных
фаз” is a residual, not measured model/prefill/queue time. Missing phase/usage
fields remain unknown; reasoning tokens are not added to output again. Repeated
calls count additional calls with the same tool name, not proven mistakes.
Retries count observed agent retry-attempt transitions, not hidden provider
retries. Explicit older parents cannot contribute to a newer steered request.

The agent ending, failing or being stopped is distinct from owner acceptance and
independent verification in task-result cards. No settings, reasoning effort,
permissions, retry behavior, prompts or skills are automatically changed.

When Hub collection is enabled, the existing spool attaches the numeric summary
to its user record. The server accepts an exact numeric schema, keeps device
observations separate, refuses text/invalid values and prevents a history-only
replay from erasing known live timings. Metadata retention removes these records.
No additional data collection consent or raw reasoning collection is introduced.
