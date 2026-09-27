Detect conflicts only in files written by the change's own revisions

A change's conflicts are the files, among those written by revisions no parent has, whose tip holds conflict markers; a merge revision writes only the files it did not take whole from one side. A root is never conflicted, so a stale trunk parent is no longer read in full.
