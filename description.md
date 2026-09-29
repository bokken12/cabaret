cab change todo: list the lines a change's diff adds that mention TODO, as path:line: text. Searches only files the change edited since its bases and only lines it added, so parents' TODOs and ones merely carried through a rename don't show. Binary files are skipped. No filtering by addressee yet.

Joel: The AddedLine representation seems like a bad one to me.