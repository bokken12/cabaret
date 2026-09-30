Witness that landing an unlogged branch orphans its children

A branch without a log declares no parents and targets the default branch. Once it is archived, `Metadata::parents` returns its empty declared set, and its children's archived-parent substitution adds nothing, so they become roots. The test records the current empty parents with a TODO; the child change fixes it.