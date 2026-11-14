// Checks that the claude CLI is installed and signed in. Kept free of the reviewer's
// other modules, so the local runner's doctor can make the same checks.
import { execFile } from "node:child_process";

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
