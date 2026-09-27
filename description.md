Commit conflicts in diff3 style rather than zealous diff3

Zealous diff3 moves lines common to both sides out of the conflict, so the file no longer holds either side or the base whole. Plain diff3 keeps the markers a faithful three-way serialization, leaving room to read a conflict's terms back later. The new rebase test pins a conflict where the two styles differ.
