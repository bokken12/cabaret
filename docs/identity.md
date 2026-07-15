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

My leaning is towards basing identity on `user.email`. Although it would require some trust, git is already fairly permissive by default.

## Aliases

An identity is one `user.email`, but a user may have several: an agent working on their behalf under its own email, another machine, a forge's noreply address. The multi-valued git config key `cabaret.alias` names the other identities that count as you:

    cabaret config alias add agent@example.com

Aliases are a property of the person, not of any repository — global config is their natural home — and they act only when reading: a change owned by an alias is yours to operate, and its work shows on your todo. Log entries are always written under your own `user.email`, and obligations count each identity's own reviews, so an alias's review never satisfies a demand naming you (nor the reverse).

Claiming an alias grants nothing that setting `user.email` to it would not, so a purely local declaration costs no trust beyond what git already extends.

