# Agents

Cabaret is primarily intended to be a code review tool, and mostly hopes to stay in its lane as such. There are already too many agent harnesses & orchestrators out there, and Cabaret does not hope to become one.

More pointedly, Cabaret hopes to stay fairly neutral in debates about AI coding. It hopes to be a tool which is useful for wrangling and understanding agents in much the same way as it is useful for wrangling and understanding human teammates. Good tools are good for both.

That said, in the present day many developers are working with agents, and they are relevant to the code review experience. When reviewing code, it may be useful context to see for example the transcripts of local or cloud sessions which worked on a particular change.

Therefore, when applicable, Cabaret will attempt to surface relevant sessions to a given review and make it easy to revisit them. Cabaret will not otherwise try to impose opinions about which agent harnesses as user should prefer or how or even whether they should use them.

The cleanest way to do so appears to be through Zed/Jetbrain's Agent Client Protocol (ACP). I will try and get the required functionality out of this so that I do not find myself building support for a zoo of harnesses, although may end up needing to abandon it and go custom.

Good cabaret workflows to support might include:
- When reviewing a change your local agent wrote, you re-open its session in the editor and ask it some questions about the code or tell it to make changes.
- After writing up the title and description of a new change, you delegate an initial implementation to an agent, or ask it to create 3 possible versions as children.
