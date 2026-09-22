# Contributing

Thanks for your interest. This is an open reference implementation of a verifiable
data-custody and relay-payment layer for DTN, settled on BSV.

## Scope

In scope for this repository (the open core):
- the protocol and content-addressing route (`agent/lib`)
- the agent (`agent/source.mjs`, `relay.mjs`, `dest.mjs`)
- DTN transport adapters (`transport/`, `m0/`, `r2/`)
- the on-chain verifiers (`live/`)
- tests, docs, contact plans

Out of scope here (operated separately, not part of this project): a hosted BSV
settlement facilitator, a relay marketplace, managed key custody, and enterprise or
compliance features.

## Ground rules

- **No secrets.** Never commit private keys, wallet mnemonics, WIFs, `.env` files, or
  funded credentials. The live paths take keys and txids from your own environment.
- **Keep the core dependency-light.** `agent/`, `transport/sim.mjs`, `m0/`, and the
  tests run on Node with no dependencies. `@bsv/sdk` is used only by the live anchor
  builder.
- **Tests must pass.** `npm test` should stay green. Add a test with any behaviour
  change.
- **Match the boundary.** This layer is medium- and rail-agnostic and does not touch
  the physical link (RF/optical, coding, FEC). Keep it that way.

## How to contribute

1. Fork and branch.
2. Make the change; run `npm test` (and `make spike-local` / `make r2` / `make live`
   where relevant).
3. Open a pull request describing what and why. By submitting a contribution you agree
   it is licensed under Apache-2.0 (see `LICENSE`), per section 5 of that license.

## Developer Certificate of Origin

Sign off your commits (`git commit -s`) to certify you have the right to submit the
work under the project license (the [DCO](https://developercertificate.org/)).
