# Security Policy

## Reporting a vulnerability

Please report security issues privately to **support@embryospace.com** rather than
opening a public issue. Include a description, affected files or commit, and a
reproduction if you have one. We will acknowledge and work with you on a fix and
coordinated disclosure.

## Scope and expectations

- This is a **reference implementation**, not an audited production library. Review it
  before relying on it in production, and run your own security assessment.
- **You hold your own keys and funds.** Nothing here custodies keys or broadcasts
  transactions on your behalf; the live paths take keys and settlement txids from your
  environment, and building an anchor transaction never broadcasts it.
- The demo signing keys use Ed25519 for portability; a production deployment uses the
  compact BSM / recover-to-key envelope from `@bsvkey/x402-bsv-client`. The
  content-addressing route is identical.
- What the layer proves and does **not** prove is stated explicitly in the docs and
  tests: it proves custody, authorship, delivery binding, and provenance, not that the
  underlying compute or the physical link is correct.

## Good practice when using this

- Bind delivery to the settlement **you** paid (`bindDelivery` / `verifySettlementOnChain`);
  never trust a receipt's self-declared settlement without checking it against your own
  transaction. An unbound check refuses by design.
- Verify custody chains against the hop keys you pin, not keys carried in the record.
