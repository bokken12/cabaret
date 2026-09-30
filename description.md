Create parents from a change's computed parents

`create_parent` now reads `Metadata::parents` rather than the declared set, so an unlogged branch gets a parent on the default branch, and an archived parent is skipped for the change it landed into.