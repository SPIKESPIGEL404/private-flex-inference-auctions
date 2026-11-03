# Phase-two regression data

`phase1-journal-b5bcc26.json` contains the SQLite metadata/action/event rows from
the public synthetic walkthrough, independently rebuilt from commit `b5bcc26`.
It has 14 journal records and schema version 1. It contains only the public
phase-one fixture identity and synthetic input, not a production database.

The upgrade test imports these frozen rows into a fresh SQLite database, opens
them with the phase-two code, checks recovery mode, and then registers plan 3
and adds real loopback HTTP observations. This tests backward reading of the old
materialized state and event projection, rather than regenerating old-format
data using the new reducer. Reverse/downgrade compatibility is not claimed.
