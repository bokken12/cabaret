# Obligations

Obligations determine who needs to review which files in a change. They are Cabaret's equivalent of `CODEOWNERS`. They are called "obligations" to signal that they are a responsibility: if you ask for the power to restrict others' changes, then you are obliged to be timely and helpful.

## Blocking vs Following

There are two kinds of review, and one can require either or both:

- Gated "blocking" review: expresses that changes touching these files cannot land until the reviewers sign off on it.
- Async "follow" review: expresses that the reviewers want to see the changes being made to these files.

"follow" review is the default kind, since blocking review imposes more restrictions.

## Location

Obligations on a file are inherited from any parent directory's obligations files except when explicitly marked as not inheriting (e.g. because a subfolder is lower scrutiny than its surroundings). 

This makes them more difficult to parse than the single repo-level `CODEOWNERS` mechanism, but for large monorepos that does not scale and most similar review systems have landed on more granular files.

In practice obligations files are not expected to be placed arbitrarily deep in the tree. They are likely to live at the level of projects or teams, where it starts to make sense to have a single file which discusses all its subfolder rules.

## Expressivity

The obligations system aims to be fairly expressive, allowing you to write things like "one of these reviewers or three of those reviewers or 3 days have passed", which cannot easily be written in `CODEOWNERS`, but to do so while keeping the ordinary cases short.

## Reviewers

In addition to the per-file obligations system, there are also per-change reviewers. They are assigned review for all files in the change, and must explicitly grant whole-change approval before it lands. The required number of such reviewers can be configured at the repository level or at do-not-inherit root subfolders.
