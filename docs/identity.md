# Identity

When we record the review that some user has performed, we must associate it with some identity so that they can resume at that state later. What should that identity be? Let's consider some options.

## Possible Identities

### GitHub Accounts

GitHub already has a strong version of identity through its accounts, which would work well here. However this is not something we can validate offline, and it ties us too closely to a single forge.

### Git `user.name`

Git allows you to configure a `user.name` to associate with your commits. This would fit neatly in our data model as simple and configurable, but can be set arbitrarily to be non-unique, impersonate others, or have awkward formatting (e.g. include spaces).

### Git `user.email`

When representing a user's real email, `user.email` is more likely to be unique, although at the same time may be more unwieldy to type. It still suffers from impersonation and similar.

### Public Key Cryptography

Public key crypography could provide a method of distributed identity verification, but may be more intimidating for users.

## Proposed

My leaning is towards basing identity on `user.email`. Although it would require some trust, git is already fairly permissive by default. Forge accounts join as a second written form (below); aliases stitch a person's identities together.

## Forge Accounts

A forge account is an identity of its own, written as the account under a scheme naming its forge: `github:alice`, `gitlab:alice`, `codeberg:alice`, `bitbucket:alice`. Everything imported from a forge — change authors, reviewers, comment authors — carries this form.

The identity is minted from the account name alone: the mapping is total and offline, inverts by parsing (which review requests need), and cannot shift when someone edits their profile. A profile's public email would sometimes unify an account with its owner's git identity, but only while shown, and never reliably — that unification is the alias layer's job. The forges' own noreply spellings (`5+alice@users.noreply.github.com` and kin) name the same account wherever an identity is typed.

Your own account is bridged by an alias rather than by changing what you write under: pulling asks the forge which account its credentials authenticate and records it — and each email the account's profile shows — as a `cabaret.alias` when it does not already count as you. The declarations land in the repository's local config — the association is the repository's, since another repository's credentials may front a different account. From then on, changes those identities authored or were asked to review read as yours.

Declaring an account by hand goes through the same scheme without spelling it: `cab config alias github add alice` stores `github:alice`, and each forge has the same `show`, `add`, `remove`, and `clear` under its name.

## Aliases

An identity is one name, but a user may have several: an agent working on their behalf under its own email, another machine, a forge account. The multi-valued git config key `cabaret.alias` names the other identities that count as you:

    cab config alias add agent@example.com

Hand-declared aliases are a property of the person, not of any repository — global config is their natural home — and they act only when reading: a change owned by an alias is yours to operate, and its work shows on your home page. Log entries are always written under your own `user.email`, and obligations count each identity's own reviews, so an alias's review never satisfies a demand naming you (nor the reverse).

Claiming an alias grants nothing that setting `user.email` to it would not, so a purely local declaration costs no trust beyond what git already extends.

