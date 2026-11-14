// Checks that the claude CLI is installed and signed in, and reads the fallback
// settings. Kept free of the reviewer's other modules, so the local runner's
// doctor can make the same checks as the review.
import { execFile } from "node:child_process";

/** How claude signs in: a token or key in the environment, or else the claude CLI's own login. */
export function claudeLoginOf(env: Record<string, string | undefined>): "token" | "api-key" | "cli" {
  return env.CLAUDE_CODE_OAUTH_TOKEN?.trim() ? "token" : env.ANTHROPIC_API_KEY?.trim() ? "api-key" : "cli";
}

/** Command Code's OpenAI-compatible provider API, the default fallback endpoint. */
export const DEFAULT_FALLBACK_BASE_URL = "https://api.commandcode.ai/provider/v1";

export interface Fallback {
  model: string;
  baseUrl: string;
  apiKey: string;
}

/** The fallback RB_CONFIG_FALLBACK names, or null when it is off. Throws on a setting the review cannot use. */
export function fallbackOf(env: Record<string, string | undefined>, engine: string): Fallback | null {
  const model = env.RB_CONFIG_FALLBACK?.trim() || "off";
  if (model === "off") return null;
  if (engine !== "claude-code") throw new Error("RB_CONFIG_FALLBACK needs RB_CONFIG_ENGINE=claude-code");
  const apiKey = env.CMD_API_KEY?.trim();
  if (!apiKey) throw new Error("RB_CONFIG_FALLBACK needs CMD_API_KEY, the fallback endpoint's key");
  const baseUrl = (env.RB_FALLBACK_BASE_URL?.trim() || DEFAULT_FALLBACK_BASE_URL).replace(/\/+$/, "");
  let protocol = "";
  try {
    protocol = new URL(baseUrl).protocol;
  } catch {
    // Reported below.
  }
  if (protocol !== "https:" && protocol !== "http:") throw new Error(`RB_FALLBACK_BASE_URL must be an http or https URL, not ${baseUrl}`);
  return { model, apiKey, baseUrl };
}

export const NOT_INSTALLED = "Claude Code is not installed in this image; build it with --build-arg CLAUDE_CODE_VERSION=<exact version>";

/** Why Claude Code cannot run here, or null when it can. */
export function claudeCodeProblem(command = "claude"): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, ["--version"], { timeout: 30_000 }, (error) => {
      if (!error) return resolve(null);
      resolve((error as NodeJS.ErrnoException).code === "ENOENT" ? NOT_INSTALLED : `claude --version failed: ${error.message}`);
    });
  });
}

/**
 * Why the claude CLI's own login cannot be used, or null when it is signed in. Only
 * asked when no CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY is set. On macOS the
 * login lives in the keychain, so a locked keychain reads as signed out.
 */
export function claudeLoginProblem(command = "claude"): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, ["auth", "status"], { timeout: 30_000 }, (error, stdout) => {
      let status: { loggedIn?: unknown; authMethod?: unknown } | null = null;
      try {
        status = JSON.parse(stdout);
      } catch {
        // Older versions print text. Trust them only when the command succeeded.
      }
      if (status ? status.loggedIn === true : !error) return resolve(null);
      resolve("claude is not signed in: run `claude auth login` (on macOS, also unlock the login keychain), or set CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`, which needs no keychain, or ANTHROPIC_API_KEY");
    });
  });
}
