Keep added workspaces' gitdir free of other workspaces

Adding a workspace from inside a linked one recorded its git dir through that workspace's
`..` path to the common dir, so removing the workspace it was added from left it pointing
nowhere and git refused to run in it. The common dir is canonicalized first, as
`default_workspace_path` already does.