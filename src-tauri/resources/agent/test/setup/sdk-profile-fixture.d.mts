// Types for sdk-profile-fixture.mjs (shared Vitest/Node-suite SDK profile fixture).
export const FIXTURE_TOOL_MARKER: "enki-vitest-sdk-profile-placeholder";
export const FIXTURE_TOOL_EXIT: 97;
export const TOOLS: readonly ["rg", "fd"];
export function exe(name: string): string;
export function generateProfile(parent: string): string;
export function releaseProfile(parent: string): void;
