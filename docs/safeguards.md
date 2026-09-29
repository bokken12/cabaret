# Safeguards

Cabaret seeks to be friendly to newcomers, keeping them on "the happy path" both by pushing towards suggested modes of use (e.g. with keybinding hints and "next step" guidance) and also by protecting against more dangerous actions. However, Cabaret hopes to be valuable to experienced operators who may sometimes need to venture off the beaten path.

To balance between these competing priorities, Cabaret has a notion of "safeguards". These are conditions under which actions are considered to be unwise or discouraged, but which users can choose to explicitly bypass when needed. Below is a (non-exhaustive) list of safeguards on actions in Cabaret and reasons why they should apply.

## Land

- Not owner
    - Many users performing distributed merges leads to complex commit graphs and conflicts
- Review obligations not met
    - self-explanatory
- Parent review obligations not met
    - requires re-review of the child diff on the parent
- Conflicted
    - causes the parent to become conflicted
- Parent conflicted?
- Archived?
- Parent archived?

## Rebase

- Not owner
    - Many users performing distributed merges leads to complex commit graphs and conflicts
- Conflicted
    - May cause more complex nested conflicts
- Parent conflicted
    - Causes the child to become conflicted
- Archived?
- Parent archived?

## Owners

- Remove non-self
    - May cause other user to lose track of a change
- Change left with no owners
    - May cause change to become orphaned
- Edit archived?

## Parents

- Remove parent which causes the base to be changed
    - May cause that parent's diff to be included in the child
- Change left with no parents
    - Has nowhere to release into
- Change left without a greatest common ancestor
    - May prevent change from ever reaching a single parent
- Add archived parent to unarchived child
    - Will be automaticaly skipped by parent inference
- Edit archived?

## Workspace

- Remove with uncommitted changes
    - Those changes are lost permanently
- Add archived?

## Commit

- Commit to archived?

## Permanence

- Edit archived?

## Archiving

- Archive permanent feature
    - Intended to be permanent?
