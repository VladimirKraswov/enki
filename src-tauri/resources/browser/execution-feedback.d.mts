export function executionFeedback(engine: string, tool: string, output: string, isError?: boolean): { outcome: "timed_out"; message: string } | undefined;
