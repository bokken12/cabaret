Start files pages' cursor on the first file

Pages now carry the line their cursor starts on, which the VS Code frontend uses whenever it has no remembered position for a page. Files pages start on their first listed file, so r/d/w followed by Enter opens the first diff; their heading no longer links to it.