# Phase-four contract fixture

`session.json` is a public, synthetic no-GPU profile. Its canonical profile digest
was generated independently by the Python Chutes front door and is checked by
Rust tests. It is not a model/GPU calibration result and must never be used as a
live deployment profile.

The tests additionally cover strict HTTPS endpoint/credential handling, missing
or wrong stream identity, duplicate identity, frozen input-token echo, durable
results, timing order and full-profile binding to signed scheduler policy.
