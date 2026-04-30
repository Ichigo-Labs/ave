# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text
- Technical prose only, be kind but direct (e.g., "Thanks @user" not "Thanks so much @user!")

## Code Quality

- No `any` types unless absolutely necessary
- Check node_modules for external API type definitions instead of guessing
- **NEVER use inline imports** - no `await import("./foo.js")`, no `import("pkg").Type` in type positions, no dynamic imports for types. Always use standard top-level imports.
- NEVER remove or downgrade code to fix type errors from outdated dependencies; upgrade the dependency instead
- Always ask before removing functionality or code that appears to be intentional
- Do not preserve backward compatibility unless the user explicitly asks for it
- Never hardcode key checks with, eg. `matchesKey(keyData, "ctrl+x")`. All keybindings must be configurable. Add default to matching object (`DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS`)

## Commands

- After code changes (not documentation changes): `npm run check` (get full output, no tail). Fix all errors, warnings, and infos before committing.
- Note: `npm run check` does not run tests.
- NEVER run: `npm run dev`, `npm run build`, `npm test`
- Only run specific tests if user instructs: `npx vitest --run test/specific.test.ts`
- Run tests from the repo root.
- If you create or modify a test file, you MUST run that test file and iterate until it passes.
- TUI tests use Node.js test runner, not vitest: `npx tsx --test test/tui/fuzzy.test.ts`
- NEVER commit unless user asks

## Project Structure

This is a single package (`@ichigo.moe/ave`). All source is under `src/`:

- `src/ai/` - Unified LLM API with provider implementations
- `src/agent/` - Agent core with tool calling and state management
- `src/tui/` - Terminal UI library with differential rendering
- `src/core/` - Coding agent core (agent session, tools, extensions, etc.)
- `src/modes/` - Run modes (interactive, print, rpc)
- `src/cli/` - CLI argument parsing
- `src/utils/` - Utility functions
- `test/` - All tests
- `test/ai/` - AI package tests
- `test/agent/` - Agent package tests
- `test/tui/` - TUI package tests (Node.js test runner)
- `test/suite/` - Integration/regression tests
- `docs/` - Documentation
- `examples/` - Extension and SDK examples
- `scripts/` - Build and utility scripts

### Package Exports

The package exposes subpath exports for extensions:

- `@ichigo.moe/ave` - Main entry point
- `@ichigo.moe/ave/ai` - AI API
- `@ichigo.moe/ave/ai/oauth` - OAuth utilities
- `@ichigo.moe/ave/ai/bedrock-provider` - Bedrock provider module
- `@ichigo.moe/ave/agent` - Agent core
- `@ichigo.moe/ave/tui` - TUI library
- `@ichigo.moe/ave/hooks` - Extension hooks

## Contribution Gate

- New issues from new contributors are auto-closed by `.github/workflows/issue-gate.yml`
- New PRs from new contributors without PR rights are auto-closed by `.github/workflows/pr-gate.yml`
- Maintainer approval comments are handled by `.github/workflows/approve-contributor.yml`
- Maintainers review auto-closed issues daily
- Issues that do not meet the quality bar in `CONTRIBUTING.md` are not reopened and do not receive a reply
- `lgtmi` approves future issues
- `lgtm` approves future issues and rights to submit PRs

When posting issue/PR comments:

- Write the full comment to a temp file and use `gh issue comment --body-file` or `gh pr comment --body-file`
- Never pass multi-line markdown directly via `--body` in shell commands
- Preview the exact comment text before posting
- Post exactly one final comment unless the user explicitly asks for multiple comments
- If a comment is malformed, delete it immediately, then post one corrected comment
- Keep comments concise, technical, and in the user's tone

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the commit message
- This automatically closes the issue when the commit is merged

## PR Workflow

- Analyze PRs without pulling locally first
- If the user approves: create a feature branch, pull PR, rebase on main, apply adjustments, commit, merge into main, push, close PR, and leave a comment in the user's tone
- You never open PRs yourself. We work in feature branches until everything is according to the user's requirements, then merge into main, and push.

## Testing ave Interactive Mode with tmux

To test ave's TUI in a controlled terminal environment:

```bash
# Create tmux session with specific dimensions
tmux new-session -d -s ave-test -x 80 -y 24

# Start ave from source
tmux send-keys -t ave-test "npx tsx src/cli.ts" Enter

# Wait for startup, then capture output
sleep 3 && tmux capture-pane -t ave-test -p

# Send input
tmux send-keys -t ave-test "your prompt here" Enter

# Send special keys
tmux send-keys -t ave-test Escape
tmux send-keys -t ave-test C-o  # ctrl+o

# Cleanup
tmux kill-session -t ave-test
```

## Changelog

Location: `CHANGELOG.md`

### Format

Use these sections under `## [Unreleased]`:

- `### Breaking Changes` - API changes requiring migration
- `### Added` - New features
- `### Changed` - Changes to existing functionality
- `### Fixed` - Bug fixes
- `### Removed` - Removed features

### Rules

- Before adding entries, read the full `[Unreleased]` section to see which subsections already exist
- New entries ALWAYS go under `## [Unreleased]` section
- Append to existing subsections (e.g., `### Fixed`), do not create duplicates
- NEVER modify already-released version sections (e.g., `## [0.12.2]`)
- Each version section is immutable once released

### Attribution

- **Internal changes (from issues)**: `Fixed foo bar ([#123](https://github.com/ichigo-Labs/ave/issues/123))`
- **External contributions**: `Added feature X ([#456](https://github.com/ichigo-Labs/ave/pull/456) by [@username](https://github.com/username))`

## Adding a New LLM Provider

Adding a new provider requires changes across multiple files:

### 1. Core Types (`src/ai/types.ts`)

- Add API identifier to `Api` type union (e.g., `"bedrock-converse-stream"`)
- Create options interface extending `StreamOptions`
- Add mapping to `ApiOptionsMap`
- Add provider name to `KnownProvider` type union

### 2. Provider Implementation (`src/ai/providers/`)

Create provider file exporting:

- `stream<Provider>()` function returning `AssistantMessageEventStream`
- `streamSimple<Provider>()` for `SimpleStreamOptions` mapping
- Provider-specific options interface
- Message/tool conversion functions
- Response parsing emitting standardized events (`text`, `tool_call`, `thinking`, `usage`, `stop`)

### 3. Provider Exports and Lazy Registration

- Add a package subpath export in `package.json` pointing at `./dist/ai/providers/<provider>.js`
- Add `export type` re-exports in `src/ai/index.ts` for provider option types that should remain available from the root entry
- Register the provider in `src/ai/providers/register-builtins.ts` via lazy loader wrappers, do not statically import provider implementation modules there
- Add credential detection in `src/ai/env-api-keys.ts`

### 4. Model Generation (`scripts/generate-models.ts`)

- Add logic to fetch/parse models from provider source
- Map to standardized `Model` interface

### 5. Tests (`test/ai/`)

- Always add the provider to `stream.test.ts` with at least one representative model, even if it reuses an existing API implementation such as `openai-completions`.
- Add the provider to the broader provider matrix where applicable: `tokens.test.ts`, `abort.test.ts`, `empty.test.ts`, `context-overflow.test.ts`, `image-limits.test.ts`, `unicode-surrogate.test.ts`, `tool-call-without-result.test.ts`, `image-tool-result.test.ts`, `total-tokens.test.ts`, `cross-provider-handoff.test.ts`.
- For `cross-provider-handoff.test.ts`, add at least one provider/model pair. If the provider exposes multiple model families (for example GPT and Claude), add at least one pair per family.
- For non-standard auth, create utility (e.g., `bedrock-utils.ts`) with credential detection.

### 6. Coding Agent Integration

- `src/core/model-resolver.ts`: Add default model ID to `defaultModelPerProvider`
- `src/modes/interactive/interactive-mode.ts`: Add API-key login display name to `API_KEY_LOGIN_PROVIDERS` so `/login` shows the provider for built-in API-key auth.
- `src/cli/args.ts`: Add env var documentation
- `README.md`: Add provider setup instructions
- `docs/providers.md`: Add setup instructions, env var, and `auth.json` key

### 7. Documentation

- Add entry under `## [Unreleased]` in `CHANGELOG.md`

## **CRITICAL** Git Rules for Parallel Agents **CRITICAL**

Multiple agents may work on different files in the same worktree simultaneously. You MUST follow these rules:

### Committing

- **ONLY commit files YOU changed in THIS session**
- ALWAYS include `fixes #<number>` or `closes #<number>` in the commit message when there is a related issue or PR
- NEVER use `git add -A` or `git add .` - these sweep up changes from other agents
- ALWAYS use `git add <specific-file-paths>` listing only files you modified
- Before committing, run `git status` and verify you are only staging YOUR files
- Track which files you created/modified/deleted during the session
- It is always fine to include `src/ai/models.generated.ts` in a commit alongside the actual files you want to commit

### Forbidden Git Operations

These commands can destroy other agents' work:

- `git reset --hard` - destroys uncommitted changes
- `git checkout .` - destroys uncommitted changes
- `git clean -fd` - deletes untracked files
- `git stash` - stashes ALL changes including other agents' work
- `git add -A` / `git add .` - stages other agents' uncommitted work
- `git commit --no-verify` - bypasses required checks and is never allowed

### Safe Workflow

```bash
# 1. Check status first
git status

# 2. Add ONLY your specific files
git add src/ai/providers/transform-messages.ts
git add CHANGELOG.md

# 3. Commit
git commit -m "fix(ai): description"

# 4. Push (pull --rebase if needed, but NEVER reset/checkout)
git pull --rebase && git push
```

### If Rebase Conflicts Occur

- Resolve conflicts in YOUR files only
- If conflict is in a file you didn't modify, abort and ask the user
- NEVER force push

### User override

If the user instructions conflict with rules set out here, ask for confirmation that they want to override the rules. Only then execute their instructions.
