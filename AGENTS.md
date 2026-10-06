# Cabaret

In the Cabaret repository, please follow Cabaret conventions. Notably:

- Commit eagerly to share your work, but don't land yourself without review.
- Prefer dogfooding `cab` CLI to plain `git`. You can run your local CLI with `pnpm cab`.
- If you notice something that could be improved about Cabaret, consider adding it as a separate change for review.
- Slice diffs thinly. If you're working on a bigger project consider whether you can split it into a stack of smaller pieces.

`docs/` describes the main architectural decisions. It is only for humans to write to, so if you conclude a new doc is necessary, please create a change with a TODO in the description for a human to write it rather than making it yourself.


## Agent session links

- Keep only one explicit worktree/change link for your session at a time.
- Keep the link while the change is open for review, including after commits, test runs,
  publishing a PR, completing a turn, or stopping the session. These do not release the link.
- Unlink after the user confirms the change has landed, explicitly asks to remove the link,
  or assigns the session to a different task. Before linking elsewhere, run
  `cab -C /path/to/old-worktree session unlink`.
  For Claude, also supply `--provider claude --id <your-session-id>`.
- If the old worktree was removed, run from another checkout of that repository with
  `session unlink --change <old-change>` and the same provider/session ID.
- A session launched inside a worktree belongs to that worktree. Finish it there and
  start a fresh session for another worktree instead of carrying its old context across.
- A session launched from a parent container may move between worktrees after unlinking.
  Cabaret does not terminate sessions or automatically unlink on landing. The agent must
  explicitly release the link once it knows the change has landed or the task has changed.
