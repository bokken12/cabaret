Prefix change ids

`cab config prefix set 'joel/%m%d-'` puts a prefix before the id of each change you create,
so the names you pick need only be unique among your own. strftime escapes expand to the
local time of creation, and a template whose expansion cannot start a ref name is refused
when set. The name you gave becomes the change's title, since the id no longer reads as it.

`create` and `create_parent` now take the name as a plain string, since only the prefixed id
must be a valid ref name, and return the id they chose; the CLI and VS Code report that id.
There is no way yet to create an exact id past a configured prefix.