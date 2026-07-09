# Terminology

Brainstorming proper terminology for Cabaret

## Reviewable Unit

What should one call the item which can be reviewed?

- GitHub calls this a "pull request (PR)"
- Iron calls this a "feature"
- Critique calls this a "change list (CL)"

People probably come in most familiar with GitHub terminology, although I'm a bit partial to descriptive words like "feature" over acronyms, but some people think of that as being a more precise term which might not include e.g. a bug fix.

Possibly something like a "change" following JJ might be reasonable? Although if it doesn't always line up 1:1 with JJ changes that could be confusing.

Tentative: I'm going to call this a "change" - and in a future JJ backend I think a JJ change would line up 1:1 with a Cabaret change. If this turns out badly, my second choice is "feature".

## Groups

What should one call a set of people responsible for review?

- GitHub calls this a "team"
- Iron calls this a "role"

I'm pretty ambivalent here - both seem like good short names, but "team" maybe implies a certain organizational meaning that is not always true.

Tentative: I'm going to call this a "role". If this turns out badly, my second choice is "group".

## Endorsement

What should one call a successful review?

- GitHub calls this "approve"
- Iron calls this "second"
- Critique calls this "looks good to me (LGTM)"

To me "approve" seems like the clearest here, although maybe "second" emphasizes a slightly different meaning and I should think if there's a clearer way to have that? Maybe something like "vouch"?

Tentative: I'm going to call this "approve". If this turns out badly, my second choice is "endorse".

## Requirements

What should one call requirements to review code?

- GitHub and Critique call this "ownership"
- Iron calls this "obligations"

In general I like the implications of "obligations" more than that of "ownership". Owning things sounds good, like it makes you important and should be encouraged. In contrast obligations sounds like you have created for yourself a task and a responsibility, which I think is more how people should feel about it. On the other hand the word "obligation" feels imperfect to me - slightly outside of common parlance.

## Landing

What should one call the final step after approval?

- GitHub just calls this "merge" like git
- Iron calls this "release"
- Critique calls this "submit"

Also fairly happy with any of these, although I think "release" perhaps falsely implies rollout, and "submit" perhaps falsely implies a merge queue.

Tenatative: I'm going to call this "land". If this turns out badly, my second choice is "merge".

## Comments

What should signify a comment needing to be addressed?

- Iron uses "CR"

honestly I kind of like "TODO"? It's longer, but feels more universally acknowledged - and in general I prefer to avoid acronyms?

# Versions

I like JJ's "revision" over git's "commit", the commit feels like the action
