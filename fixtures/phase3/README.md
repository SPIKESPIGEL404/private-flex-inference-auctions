# Phase-three compatibility data

`phase2-journal-085a09b.json` contains schema-v1 SQLite metadata/action/event rows
from an independently rebuilt commit `085a09b`. Its `phase2_mock` example used
three synthetic requests against its own loopback mock, then reopened the journal.
The fixture captures all 15 records, including complete stream reports and the
old materialized state. No production data or credentials are included.

Phase-three tests import the frozen rows verbatim and check replay, recovery and
all three COMPLETE_PROTOCOL summaries. Results correctly remain Pending because
the old adapter never persisted result files. Enabling spool for these already
submitted executions is rejected. Reverse compatibility with old binaries is
not claimed.
