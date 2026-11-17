# Testing floodwall

Run one test command at a time.

## Crate

```sh
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test --all
cargo run --example production           # the OPA/Rego-style guardrails at the gate
```

## Independent ledger verifier

`tools/verify-ledger.mjs` checks a ledger export with nothing but Node's standard library.
CI exports the demo's ledger and verifies it; to do the same locally:

```sh
cargo run --release -- --export target/audit --ledger target/audit/durable.jsonl
node tools/verify-ledger.mjs target/audit/ledger.jsonl target/audit/keys.json
node --test tools/verify-ledger.test.mjs
```

## SDKs

```sh
npm --prefix sdk/typescript test
(cd sdk/mcp && npm install --ignore-scripts --no-package-lock --no-save ../typescript && npm test)
(cd sdk/python && python3 -m unittest discover -s tests -t .)
```
