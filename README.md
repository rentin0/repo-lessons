# Repo Lessons

[日本語](README.ja.md)

Keep project lessons in Git and bring relevant ones into Codex and Claude Code when you send a prompt. A lesson can be a recurring mistake, a test requirement, or a project convention that is easy to miss.

Each lesson is a separate JSON file. Your team can review additions in a pull request, merge independent additions, and supersede outdated lessons without editing the originals. Both agents read the lessons from the Git checkout they are working in.

**Status:** Early release.

## Install

You need Git, Node.js 24, and either Codex CLI or Claude Code. Run the commands for your client.

```sh
# Codex
codex plugin marketplace add https://github.com/rentin0/repo-lessons.git
codex plugin add repo-lessons@repo-lessons

# Claude Code
claude plugin marketplace add https://github.com/rentin0/repo-lessons.git
claude plugin install repo-lessons@repo-lessons
```

In Codex, review and approve the plugin's `UserPromptSubmit` hook when prompted or from `/hooks`. If your project already registers an equivalent hook, keep one registration active to avoid duplicate context.

## Try it in a Git repository

Clone Repo Lessons to use its CLI, then switch to the root of a Git repository where you want to try the plugin.

```sh
git clone https://github.com/rentin0/repo-lessons.git
lessons_marketplace="$(cd repo-lessons && pwd)"
cd /path/to/your/git-repository

node "$lessons_marketplace/plugins/repo-lessons/.agents/lessons/cli.ts" \
  add 'When updating a cache key, document how stale entries are removed.' \
  --root "$PWD" --tag caching
```

Commit the generated file under `.agents/lessons/records/` to share it with your team. From that repository, open either client and send a related prompt, such as “What should I check before updating a cache key?”

To correct a lesson, use the CLI's `search --json` to find its full ID. Add the revised lesson with `--supersedes <ID>`. The old entry stays in Git and drops out of search.

## Configure prompt search

Create `~/.config/repo-lessons/config.json` to customize both clients:

```json
{
  "minSimilarity": 0.25,
  "limit": 3
}
```

- `minSimilarity` defaults to `0.12` and accepts numbers from `0` to `1`. Raise it to get stricter matches and lower it to broaden the results.
- `limit` defaults to `5` and accepts integers from `1` to `100`. It caps the number of lessons selected. Each client may also limit how much hook output it includes.
- Omitted settings use their defaults. A malformed config falls back to both defaults. The hook reads the file on every prompt. Set `REPO_LESSONS_CONFIG` to an absolute path if you want to use a different file.

## How it works

On each prompt, the plugin finds the root of the current Git checkout and searches its lesson records. It uses word and character similarity to select up to five results by default, then passes their text and source paths to the client as extra context.

Search runs locally without a search service, embedding API, or vec1 setup. The selected excerpts become part of the agent's context and can be included in requests to your configured model provider.

## License

[MIT](LICENSE)
