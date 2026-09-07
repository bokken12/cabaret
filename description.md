Cabaret has a good visualization for a change's diff: base to most recently committed version.

However, it does not have a great visualization for the workspace diff: most recently committed version to uncommitted files.

This change adds the latter view, sharing code/infra where appropriate and with appropriate rust backing.

Within this view: ! C commits all files, while ! c commits just selected files (or just the file on current line if no selection)